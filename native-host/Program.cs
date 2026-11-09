// Native messaging host for the Email Extension extension.
//
// Chrome starts this program on demand (no terminal, no .bat). On an "ensure"
// request it makes sure the local storage service is running, starting it hidden
// and detached from Chrome when needed, and returns the service token so the
// extension never asks the user to paste it. Every Chrome profile of the current
// Windows user reaches the same host, so all profiles share one service and one
// SQLite database.

using System.ComponentModel;
using System.Net.Http.Headers;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

internal static class Program
{
    private const string ServiceUrl = "http://127.0.0.1:4317";
    private static readonly TimeSpan StartTimeout = TimeSpan.FromSeconds(30);

    private static int Main(string[] args)
    {
        string? callerOrigin = args.FirstOrDefault(a => a.StartsWith("chrome-extension://", StringComparison.Ordinal));
        try
        {
            while (true)
            {
                JsonNode? request = ReadMessage();
                if (request is null) return 0;
                WriteMessage(Handle(request, callerOrigin));
            }
        }
        catch (Exception error)
        {
            try { WriteMessage(Fail(error.Message)); } catch { /* Chrome already disconnected. */ }
            return 1;
        }
    }

    private static JsonObject Handle(JsonNode request, string? callerOrigin)
    {
        string type = request["type"]?.GetValue<string>() ?? "";
        return type switch
        {
            "ensure" => Ensure(callerOrigin),
            "ping" => new JsonObject { ["ok"] = true, ["version"] = 1 },
            _ => Fail($"Unsupported request '{type}'.")
        };
    }

    private static JsonObject Ensure(string? callerOrigin)
    {
        string root = ProjectRoot();
        string serviceDirectory = Path.Combine(root, "service");
        string tokenPath = Path.Combine(serviceDirectory, "token.txt");

        // Two profiles may open the extension at the same moment; only one starts the service.
        using var mutex = new Mutex(false, @"Local\JobPostEmailTracker.EnsureService");
        bool owned = false;
        try
        {
            try { owned = mutex.WaitOne(StartTimeout); } catch (AbandonedMutexException) { owned = true; }

            string? token = ReadToken(tokenPath);
            HealthInfo health = token is null ? new HealthInfo(HealthResult.Unreachable, 0, null) : Health(token);
            if (health.Result == HealthResult.Ok)
            {
                // After a code update the old service keeps running; replace it with the new code.
                if (!IsOutdated(root, health) || !StopService(health.Pid, token!))
                    return Ok(token!, started: false);
            }

            if (health.Result == HealthResult.Unauthorized)
                return Fail("Port 4317 is used by a service with a different token. Close the other tracker service window and try again.");

            StartService(root, serviceDirectory, callerOrigin);

            DateTime deadline = DateTime.UtcNow + StartTimeout;
            while (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(500);
                token = ReadToken(tokenPath);
                if (token is not null && Health(token).Result == HealthResult.Ok)
                    return Ok(token, started: true);
            }
            return Fail(@"The tracker service did not start within 30 seconds. See data\logs\service.log in the project folder.");
        }
        finally
        {
            if (owned) mutex.ReleaseMutex();
        }
    }

    // The host lives in <project>\native-host\publish\, so the project is two folders up.
    private static string ProjectRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var current = directory; current is not null; current = current.Parent)
        {
            if (File.Exists(Path.Combine(current.FullName, "service", "package.json")))
                return current.FullName;
        }
        throw new InvalidOperationException($"Could not find the project folder above {directory.FullName}.");
    }

    private static string? ReadToken(string tokenPath)
    {
        try
        {
            string token = File.ReadAllText(tokenPath).Trim();
            return token.Length >= 32 ? token : null;
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    private enum HealthResult { Ok, Unauthorized, Unreachable }

    private sealed record HealthInfo(HealthResult Result, int Pid, DateTime? StartedAt);

    private static HealthInfo Health(string token)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var message = new HttpRequestMessage(HttpMethod.Get, ServiceUrl + "/health");
            message.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            using HttpResponseMessage response = client.Send(message);
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized) return new HealthInfo(HealthResult.Unauthorized, 0, null);
            if (!response.IsSuccessStatusCode) return new HealthInfo(HealthResult.Unreachable, 0, null);
            JsonNode? body = JsonNode.Parse(response.Content.ReadAsStream());
            int pid = body?["pid"]?.GetValue<int>() ?? 0;
            DateTime? startedAt = DateTime.TryParse(body?["started_at"]?.GetValue<string>(), null, System.Globalization.DateTimeStyles.AdjustToUniversal | System.Globalization.DateTimeStyles.AssumeUniversal, out DateTime parsed) ? parsed : null;
            return new HealthInfo(HealthResult.Ok, pid, startedAt);
        }
        catch (Exception) { return new HealthInfo(HealthResult.Unreachable, 0, null); }
    }

    // True when service code changed after the running service started.
    private static bool IsOutdated(string root, HealthInfo health)
    {
        if (health.StartedAt is null || health.Pid <= 0) return false;
        DateTime newest = DateTime.MinValue;
        foreach (string folder in new[] { Path.Combine(root, "service", "src"), Path.Combine(root, "shared") })
        {
            if (!Directory.Exists(folder)) continue;
            foreach (string file in Directory.EnumerateFiles(folder, "*.ts", SearchOption.AllDirectories))
            {
                DateTime written = File.GetLastWriteTimeUtc(file);
                if (written > newest) newest = written;
            }
        }
        return newest > health.StartedAt.Value;
    }

    // Stops the running service and waits for port 4317 to free up. Returns false if it could not.
    private static bool StopService(int pid, string token)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            if (!process.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase)) return false;
            process.Kill(entireProcessTree: true);
            process.WaitForExit(5000);
        }
        catch (ArgumentException) { /* Already exited. */ }
        catch (Exception) { return false; }
        DateTime deadline = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            if (Health(token).Result == HealthResult.Unreachable) return true;
            Thread.Sleep(200);
        }
        return false;
    }

    private static void StartService(string root, string serviceDirectory, string? callerOrigin)
    {
        string node = FindNode();
        string tsxCli = Path.Combine(serviceDirectory, "node_modules", "tsx", "dist", "cli.mjs");
        if (!File.Exists(tsxCli)) tsxCli = Path.Combine(root, "node_modules", "tsx", "dist", "cli.mjs");
        if (!File.Exists(tsxCli))
            throw new InvalidOperationException("Service packages are missing. Run install.ps1 again (it runs npm install).");

        string logDirectory = Path.Combine(root, "data", "logs");
        Directory.CreateDirectory(logDirectory);
        string logPath = Path.Combine(logDirectory, "service.log");
        try
        {
            if (File.Exists(logPath) && new FileInfo(logPath).Length > 5 * 1024 * 1024)
                File.Move(logPath, logPath + ".old", overwrite: true);
        }
        catch (IOException) { /* Keep appending to the current log. */ }

        // dotenv does not override variables that are already set, so pass the union of
        // service\.env's allowed IDs and the calling extension's ID.
        var allowedIds = new SortedSet<string>(ReadEnvList(Path.Combine(serviceDirectory, ".env"), "CORS_EXTENSION_IDS"));
        if (callerOrigin is not null)
        {
            string id = callerOrigin["chrome-extension://".Length..].TrimEnd('/');
            if (id.Length == 32) allowedIds.Add(id);
        }

        string command =
            $"set \"CORS_EXTENSION_IDS={string.Join(",", allowedIds)}\" && " +
            $"echo [{DateTime.Now:yyyy-MM-dd HH:mm:ss}] Starting tracker service >> \"{logPath}\" && " +
            $"\"{node}\" \"{tsxCli}\" src/index.ts >> \"{logPath}\" 2>&1";
        string commandLine = $"\"{Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe"}\" /d /s /c \"{command}\"";
        LaunchDetached(commandLine, serviceDirectory);
    }

    private static IEnumerable<string> ReadEnvList(string envPath, string key)
    {
        if (!File.Exists(envPath)) yield break;
        foreach (string line in File.ReadAllLines(envPath))
        {
            string trimmed = line.Trim();
            if (!trimmed.StartsWith(key + "=", StringComparison.Ordinal)) continue;
            foreach (string value in trimmed[(key.Length + 1)..].Trim('"', '\'').Split(','))
                if (value.Trim().Length == 32) yield return value.Trim();
        }
    }

    private static string FindNode()
    {
        var candidates = new List<string>();
        foreach (string folder in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
            candidates.Add(Path.Combine(folder.Trim('"'), "node.exe"));
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"));
        candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe"));
        string? nvmSymlink = Environment.GetEnvironmentVariable("NVM_SYMLINK");
        if (nvmSymlink is not null) candidates.Add(Path.Combine(nvmSymlink, "node.exe"));

        return candidates.FirstOrDefault(File.Exists)
            ?? throw new InvalidOperationException("Node.js was not found. Install Node.js 22.5 or newer from nodejs.org.");
    }

    // Starts the service outside Chrome's process tree and job object, without a window
    // and without inheriting the native-messaging pipes, so it keeps running after the
    // host exits and is not tied to the Chrome window that asked for it.
    private static void LaunchDetached(string commandLine, string workingDirectory)
    {
        const uint CREATE_NO_WINDOW = 0x08000000;
        const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
        const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
        const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

        uint baseFlags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT;
        if (TryCreateProcess(commandLine, workingDirectory, baseFlags | CREATE_BREAKAWAY_FROM_JOB, out int error)) return;
        // Not in a job, or the job forbids breakaway: start normally.
        if (TryCreateProcess(commandLine, workingDirectory, baseFlags, out error)) return;
        throw new Win32Exception(error, "Could not start the tracker service");
    }

    private static bool TryCreateProcess(string commandLine, string workingDirectory, uint flags, out int error)
    {
        var startup = new STARTUPINFO { cb = Marshal.SizeOf<STARTUPINFO>() };
        var buffer = new StringBuilder(commandLine);
        bool created = CreateProcessW(null, buffer, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero,
            workingDirectory, ref startup, out PROCESS_INFORMATION info);
        error = created ? 0 : Marshal.GetLastWin32Error();
        if (created)
        {
            CloseHandle(info.hProcess);
            CloseHandle(info.hThread);
        }
        return created;
    }

    private static JsonObject Ok(string token, bool started) =>
        new() { ["ok"] = true, ["token"] = token, ["baseUrl"] = ServiceUrl, ["started"] = started };

    private static JsonObject Fail(string message) => new() { ["ok"] = false, ["error"] = message };

    // Chrome native messaging framing: 4-byte little-endian length, then UTF-8 JSON.
    private static JsonNode? ReadMessage()
    {
        Stream input = Console.OpenStandardInput();
        byte[]? header = ReadExactly(input, 4);
        if (header is null) return null;
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > 1024 * 1024) throw new InvalidDataException("Invalid message length.");
        byte[] body = ReadExactly(input, length) ?? throw new EndOfStreamException("Message ended unexpectedly.");
        return JsonNode.Parse(body);
    }

    private static byte[]? ReadExactly(Stream input, int length)
    {
        var buffer = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = input.Read(buffer, offset, length - offset);
            if (read == 0) return offset == 0 ? null : throw new EndOfStreamException();
            offset += read;
        }
        return buffer;
    }

    private static void WriteMessage(JsonObject message)
    {
        byte[] body = Encoding.UTF8.GetBytes(message.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
        Stream output = Console.OpenStandardOutput();
        output.Write(BitConverter.GetBytes(body.Length));
        output.Write(body);
        output.Flush();
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public int cb;
        public string? lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(string? applicationName, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory,
        ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
