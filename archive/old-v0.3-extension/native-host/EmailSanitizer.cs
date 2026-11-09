using System.Text.RegularExpressions;

public static class EmailSanitizer
{
    private static readonly Regex EmailPattern = new(
        @"[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly Regex StrictEmailPattern = new(
        @"\A[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}\z",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly HashSet<string> AllowedTlds = new(
        """
        com in io net org co ai edu gov info biz me us uk ca de ro tech app dev xyz online work group global solutions
        aero asia at au be br ch cl cloud club cn consulting digital es eu fi firm fr gg hr id ie il il im inc int it jp jobs kr live ltd mobi museum name nl no nz one pro ru se site software store tel travel tv ua vc website world ws zip academy agency art auto band bar bio blog business cafe capital center ceo charity chat city codes company cool email engineering enterprises esq events family finance fitness food foundation fun gallery games garden guru health help house institute international investments land law life link market marketing mba media mil mobile mortgage music news ngo ninja now partners party photography photos place plus press productions pub pw recipes red restaurant review reviews rocks science services shop social space systems technology today top town university uno vacations ventures wiki za zone
        """
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
        .ToHashSet(StringComparer.OrdinalIgnoreCase));

    private static readonly string[] AllowedTldPrefixes = AllowedTlds
        .OrderByDescending(tld => tld.Length)
        .ToArray();

    private static readonly char[] TrailingJunk =
        ['.', ',', ';', ':', ')', ']', '>', '"', '\'', '”', '’'];

    public static string? Sanitize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        foreach (Match match in EmailPattern.Matches(value))
        {
            var candidate = match.Value.Trim().TrimEnd(TrailingJunk);
            var atIndex = candidate.IndexOf('@');
            var lastAtIndex = candidate.LastIndexOf('@');
            if (atIndex <= 0 || atIndex != lastAtIndex)
            {
                continue;
            }

            var lastDot = candidate.LastIndexOf('.');
            if (lastDot <= atIndex)
            {
                continue;
            }

            var tld = candidate[(lastDot + 1)..];
            if (!AllowedTlds.Contains(tld))
            {
                var allowedPrefix = AllowedTldPrefixes.FirstOrDefault(
                    allowed => tld.StartsWith(allowed, StringComparison.OrdinalIgnoreCase));
                if (allowedPrefix is null)
                {
                    continue;
                }

                candidate = candidate[..(lastDot + 1 + allowedPrefix.Length)];
            }

            var normalizedAt = candidate.IndexOf('@');
            var localPart = candidate[..normalizedAt];
            var domain = candidate[(normalizedAt + 1)..];
            if (candidate.Length > 254 ||
                localPart.Length > 64 ||
                localPart.Contains("..", StringComparison.Ordinal) ||
                localPart.EndsWith(".", StringComparison.Ordinal) ||
                domain.Contains("..", StringComparison.Ordinal) ||
                !StrictEmailPattern.IsMatch(candidate))
            {
                continue;
            }

            return candidate;
        }

        return null;
    }

    public static List<string> ExtractEmails(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return new List<string>();
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var emails = new List<string>();
        foreach (Match match in EmailPattern.Matches(value))
        {
            var email = Sanitize(match.Value);
            if (email is not null && seen.Add(email.Trim()))
            {
                emails.Add(email.Trim());
            }
        }

        return emails;
    }

    public static List<string> NormalizeUnique(IEnumerable<string> values)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var emails = new List<string>();
        foreach (var value in values)
        {
            foreach (var email in ExtractEmails(value))
            {
                if (seen.Add(email.Trim()))
                {
                    emails.Add(email.Trim());
                }
            }
        }
        return emails;
    }
}
