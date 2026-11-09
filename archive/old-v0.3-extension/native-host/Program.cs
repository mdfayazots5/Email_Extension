using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

internal static class Program
{
    private const string StateFileName = "email-collector-state.json";
    private const string MasterFileName = "Fayaz - Email.csv";
    private const string WorkbookFileName = "Unique-Emails.xlsx";
    private const int SanitizationVersion = 1;
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private static int Main()
    {
        string projectRoot;
        try
        {
            projectRoot = FindProjectRoot();
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.Message);
            return 1;
        }

        try
        {
            MigrateStoredState(projectRoot);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(exception.Message);
            return 1;
        }

        while (true)
        {
            byte[]? input;
            try
            {
                input = ReadMessage();
                if (input is null)
                {
                    return 0;
                }
            }
            catch (Exception exception)
            {
                WriteResponse(new { ok = false, error = exception.Message });
                return 1;
            }

            try
            {
                using var document = JsonDocument.Parse(input);
                var data = HandleMessage(projectRoot, document.RootElement);
                WriteResponse(new { ok = true, data });
            }
            catch (Exception exception)
            {
                WriteResponse(new { ok = false, error = exception.Message });
            }
        }
    }

    private static object HandleMessage(string projectRoot, JsonElement message)
    {
        var type = message.TryGetProperty("type", out var typeElement)
            ? typeElement.GetString()
            : null;
        var state = LoadState(projectRoot);

        switch (type)
        {
            case "CAPTURE_EMAILS":
                var date = GetDate(message);
                if (!state.EmailsByDay.TryGetValue(date, out var dailyEmails))
                {
                    dailyEmails = new List<string>();
                    state.EmailsByDay[date] = dailyEmails;
                }

                if (message.TryGetProperty("emails", out var emailsElement) &&
                    emailsElement.ValueKind == JsonValueKind.Array)
                {
                    var unique = new HashSet<string>(dailyEmails, StringComparer.OrdinalIgnoreCase);
                    foreach (var item in emailsElement.EnumerateArray())
                    {
                        if (item.ValueKind != JsonValueKind.String)
                        {
                            continue;
                        }

                        var email = EmailSanitizer.Sanitize(item.GetString());
                        if (email is not null && unique.Add(email.Trim()))
                        {
                            dailyEmails.Add(email.Trim());
                        }
                    }
                }

                WriteState(projectRoot, state);
                return new { savedToday = dailyEmails.Count };
            case "FINALIZE":
                var collectionDate = GetDate(message);
                if (!state.EmailsByDay.ContainsKey(collectionDate))
                {
                    state.EmailsByDay[collectionDate] = new List<string>();
                }
                var masterPath = Path.Combine(projectRoot, MasterFileName);
                if (!File.Exists(masterPath))
                {
                    throw new FileNotFoundException(
                        $"The master email CSV was not found in the project folder: {MasterFileName}",
                        masterPath);
                }

                var referenceEmails = ExtractCsvEmails(File.ReadAllText(masterPath));
                if (referenceEmails.Count == 0)
                {
                    throw new InvalidDataException(
                        $"No email addresses were found in the master CSV: {MasterFileName}");
                }

                state.ReferenceEmails = referenceEmails;
                SaveStateAndWorkbook(projectRoot, state, referenceEmails);
                return new
                {
                    comparedMasterEmails = referenceEmails.Count,
                    dateSheets = state.EmailsByDay.Count
                };
            default:
                throw new InvalidDataException("Unsupported native host request.");
        }
    }

    private static string GetDate(JsonElement message)
    {
        if (message.TryGetProperty("date", out var dateElement) &&
            DateOnly.TryParse(dateElement.GetString(), out var date))
        {
            return date.ToString("yyyy-MM-dd");
        }

        return DateTime.Now.ToString("yyyy-MM-dd");
    }

    private static List<string> ExtractCsvEmails(string csv)
    {
        var rows = ParseCsv(csv);
        if (rows.Count == 0)
        {
            return new List<string>();
        }

        var emailColumns = rows[0]
            .Select((header, index) => new { header, index })
            .Where(item => item.header.Contains("email", StringComparison.OrdinalIgnoreCase))
            .Select(item => item.index)
            .ToHashSet();
        var sourceRows = emailColumns.Count > 0 ? rows.Skip(1) : rows;
        var emails = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var row in sourceRows)
        {
            var cells = emailColumns.Count > 0
                ? row.Where((_, index) => emailColumns.Contains(index))
                : row;
            foreach (var cell in cells)
            {
                foreach (var email in EmailSanitizer.ExtractEmails(cell))
                {
                    if (seen.Add(email))
                    {
                        emails.Add(email);
                    }
                }
            }
        }

        return emails;
    }

    private static List<List<string>> ParseCsv(string input)
    {
        var rows = new List<List<string>>();
        var row = new List<string>();
        var cell = new StringBuilder();
        var inQuotes = false;

        for (var index = 0; index < input.Length; index++)
        {
            var character = input[index];
            if (character == '"')
            {
                if (inQuotes && index + 1 < input.Length && input[index + 1] == '"')
                {
                    cell.Append('"');
                    index++;
                }
                else
                {
                    inQuotes = !inQuotes;
                }
            }
            else if (character == ',' && !inQuotes)
            {
                row.Add(cell.ToString());
                cell.Clear();
            }
            else if ((character == '\r' || character == '\n') && !inQuotes)
            {
                if (character == '\r' && index + 1 < input.Length && input[index + 1] == '\n')
                {
                    index++;
                }
                row.Add(cell.ToString());
                cell.Clear();
                if (row.Any(value => value.Length > 0))
                {
                    rows.Add(row);
                }
                row = new List<string>();
            }
            else
            {
                cell.Append(character);
            }
        }

        if (cell.Length > 0 || row.Count > 0)
        {
            row.Add(cell.ToString());
            if (row.Any(value => value.Length > 0))
            {
                rows.Add(row);
            }
        }

        return rows;
    }

    private static CollectorState LoadState(string projectRoot)
    {
        var path = Path.Combine(projectRoot, StateFileName);
        if (!File.Exists(path))
        {
            return new CollectorState();
        }

        var state = JsonSerializer.Deserialize<CollectorState>(File.ReadAllText(path), JsonOptions)
            ?? new CollectorState();
        state.ReferenceEmails ??= new List<string>();
        state.EmailsByDay ??= new Dictionary<string, List<string>>();
        if (state.SanitizationVersion < SanitizationVersion)
        {
            state.ReferenceEmails = EmailSanitizer.NormalizeUnique(state.ReferenceEmails);
            state.EmailsByDay = state.EmailsByDay
                .Where(item => DateOnly.TryParse(item.Key, out _))
                .ToDictionary(
                    item => item.Key,
                    item => EmailSanitizer.NormalizeUnique(item.Value));
        }
        return state;
    }

    private static void MigrateStoredState(string projectRoot)
    {
        var statePath = Path.Combine(projectRoot, StateFileName);
        if (!File.Exists(statePath))
        {
            return;
        }

        var state = LoadState(projectRoot);
        if (state.SanitizationVersion >= SanitizationVersion)
        {
            return;
        }

        var timestamp = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff");
        BackupFile(statePath, timestamp);
        BackupFile(Path.Combine(projectRoot, WorkbookFileName), timestamp);

        var masterPath = Path.Combine(projectRoot, MasterFileName);
        if (!File.Exists(masterPath))
        {
            throw new FileNotFoundException(
                $"Cannot repair captured emails because the master CSV is missing: {MasterFileName}",
                masterPath);
        }

        var referenceEmails = ExtractCsvEmails(File.ReadAllText(masterPath));
        if (referenceEmails.Count == 0)
        {
            throw new InvalidDataException(
                $"Cannot repair captured emails because no addresses were found in {MasterFileName}.");
        }

        state.SanitizationVersion = SanitizationVersion;
        SaveStateAndWorkbook(projectRoot, state, referenceEmails);
    }

    private static void BackupFile(string path, string timestamp)
    {
        if (File.Exists(path))
        {
            File.Copy(path, $"{path}.bak.{timestamp}", overwrite: false);
        }
    }

    private static void SaveStateAndWorkbook(
        string projectRoot,
        CollectorState state,
        IReadOnlyCollection<string> referenceEmails)
    {
        WriteWorkbook(projectRoot, state, referenceEmails);
        WriteState(projectRoot, state);
    }

    private static void WriteState(string projectRoot, CollectorState state)
    {
        state.SanitizationVersion = SanitizationVersion;
        var path = Path.Combine(projectRoot, StateFileName);
        var temporaryPath = path + ".tmp";
        File.WriteAllText(temporaryPath, JsonSerializer.Serialize(state, JsonOptions), new UTF8Encoding(false));
        File.Move(temporaryPath, path, true);
    }

    private static void WriteWorkbook(
        string projectRoot,
        CollectorState state,
        IReadOnlyCollection<string> referenceEmails)
    {
        var path = Path.Combine(projectRoot, WorkbookFileName);
        var temporaryPath = path + ".tmp";
        var dates = state.EmailsByDay.Keys.OrderBy(value => value, StringComparer.Ordinal).ToList();
        if (dates.Count == 0)
        {
            dates.Add(DateTime.Now.ToString("yyyy-MM-dd"));
        }
        var baseline = new HashSet<string>(referenceEmails, StringComparer.OrdinalIgnoreCase);

        using (var stream = new FileStream(temporaryPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: false))
        {
            WriteEntry(archive, "[Content_Types].xml", CreateContentTypes(dates.Count));
            WriteEntry(archive, "_rels/.rels", CreateRootRelationships());
            WriteEntry(archive, "xl/workbook.xml", CreateWorkbook(dates));
            WriteEntry(archive, "xl/_rels/workbook.xml.rels", CreateWorkbookRelationships(dates.Count));

            for (var index = 0; index < dates.Count; index++)
            {
                var date = dates[index];
                var emails = state.EmailsByDay.GetValueOrDefault(date) ?? new List<string>();
                var newEmails = emails.Where(email => !baseline.Contains(email)).ToList();
                WriteEntry(
                    archive,
                    $"xl/worksheets/sheet{index + 1}.xml",
                    CreateWorksheet(emails, newEmails));
            }
        }

        File.Move(temporaryPath, path, true);
    }

    private static string CreateContentTypes(int sheetCount)
    {
        var builder = new StringBuilder(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">" +
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>" +
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>" +
            "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>");
        for (var index = 1; index <= sheetCount; index++)
        {
            builder.Append($"<Override PartName=\"/xl/worksheets/sheet{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
        }
        return builder.Append("</Types>").ToString();
    }

    private static string CreateRootRelationships() =>
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">" +
        "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>" +
        "</Relationships>";

    private static string CreateWorkbook(IReadOnlyList<string> dates)
    {
        var builder = new StringBuilder(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" " +
            "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>");
        for (var index = 0; index < dates.Count; index++)
        {
            builder.Append($"<sheet name=\"{EscapeXml(dates[index])}\" sheetId=\"{index + 1}\" r:id=\"rId{index + 1}\"/>");
        }
        return builder.Append("</sheets></workbook>").ToString();
    }

    private static string CreateWorkbookRelationships(int sheetCount)
    {
        var builder = new StringBuilder(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
        for (var index = 1; index <= sheetCount; index++)
        {
            builder.Append($"<Relationship Id=\"rId{index}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet{index}.xml\"/>");
        }
        return builder.Append("</Relationships>").ToString();
    }

    private static string CreateWorksheet(IReadOnlyList<string> emails, IReadOnlyList<string> newEmails)
    {
        var builder = new StringBuilder(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>");
        builder.Append("<row r=\"1\">");
        AppendCell(builder, "A1", "Unique Emails for this Day");
        AppendCell(builder, "B1", "Not in Reference CSV");
        builder.Append("</row>");

        var rowCount = Math.Max(emails.Count, newEmails.Count);
        for (var index = 0; index < rowCount; index++)
        {
            var row = index + 2;
            builder.Append($"<row r=\"{row}\">");
            if (index < emails.Count)
            {
                AppendCell(builder, $"A{row}", emails[index]);
            }
            if (index < newEmails.Count)
            {
                AppendCell(builder, $"B{row}", newEmails[index]);
            }
            builder.Append("</row>");
        }

        return builder.Append("</sheetData></worksheet>").ToString();
    }

    private static void AppendCell(StringBuilder builder, string reference, string value)
    {
        builder.Append($"<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">");
        builder.Append(EscapeXml(value));
        builder.Append("</t></is></c>");
    }

    private static string EscapeXml(string value) =>
        value.Replace("&", "&amp;", StringComparison.Ordinal)
            .Replace("<", "&lt;", StringComparison.Ordinal)
            .Replace(">", "&gt;", StringComparison.Ordinal)
            .Replace("\"", "&quot;", StringComparison.Ordinal)
            .Replace("'", "&apos;", StringComparison.Ordinal);

    private static void WriteEntry(ZipArchive archive, string path, string contents)
    {
        var entry = archive.CreateEntry(path, CompressionLevel.Optimal);
        using var writer = new StreamWriter(entry.Open(), new UTF8Encoding(false));
        writer.Write(contents);
    }

    private static string FindProjectRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "manifest.json")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "Could not find the extension project folder containing manifest.json.");
    }

    private static byte[]? ReadMessage()
    {
        var lengthBytes = ReadExactlyOrEof(Console.OpenStandardInput(), 4);
        if (lengthBytes is null)
        {
            return null;
        }

        var length = BitConverter.ToInt32(lengthBytes, 0);
        if (length is < 0 or > 16 * 1024 * 1024)
        {
            throw new InvalidDataException("Native host message size is invalid.");
        }
        return ReadExactlyOrEof(Console.OpenStandardInput(), length)
            ?? throw new EndOfStreamException("Native host message ended unexpectedly.");
    }

    private static byte[]? ReadExactlyOrEof(Stream input, int length)
    {
        var buffer = new byte[length];
        var offset = 0;
        while (offset < length)
        {
            var read = input.Read(buffer, offset, length - offset);
            if (read == 0)
            {
                return offset == 0 ? null : throw new EndOfStreamException();
            }
            offset += read;
        }
        return buffer;
    }

    private static void WriteResponse(object response)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(response);
        var output = Console.OpenStandardOutput();
        output.Write(BitConverter.GetBytes(bytes.Length));
        output.Write(bytes);
        output.Flush();
    }

    private sealed class CollectorState
    {
        public int SanitizationVersion { get; set; }
        [JsonIgnore]
        public List<string> ReferenceEmails { get; set; } = new();
        public Dictionary<string, List<string>> EmailsByDay { get; set; } = new();
    }
}
