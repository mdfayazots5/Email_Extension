var cases = new Dictionary<string, string>
{
    ["**amreen@prolificxpert.com"] = "amreen@prolificxpert.com",
    ["###said.johnbi@cerebra-consulting.com"] = "said.johnbi@cerebra-consulting.com",
    ["-tapasya.bakore@truminds.com"] = "tapasya.bakore@truminds.com",
    ["/info@hexatechglobal.com"] = "info@hexatechglobal.com",
    [".bad@domain.com"] = "bad@domain.com",
    ["consultants.futurehiremanpower@atomicmail.ioSubject"] =
        "consultants.futurehiremanpower@atomicmail.io",
    ["chathurya@mechispike.comKnow"] = "chathurya@mechispike.com",
    ["Email: hr@alendei.com."] = "hr@alendei.com",
    ["TATUS.ENG@RELEVANTZ.COM"] = "TATUS.ENG@RELEVANTZ.COM"
};

foreach (var (input, expected) in cases)
{
    var actual = EmailSanitizer.Sanitize(input);
    if (actual != expected)
    {
        throw new InvalidOperationException(
            $"Sanitize failed for '{input}': expected '{expected}', got '{actual ?? "null"}'.");
    }
}

var duplicates = EmailSanitizer.NormalizeUnique(
[
    "**shanmukh@navarsecurity.com",
    "shanmukh@navarsecurity.com"
]);
if (duplicates.Count != 1 || duplicates[0] != "shanmukh@navarsecurity.com")
{
    throw new InvalidOperationException("Sanitized duplicate addresses were not deduplicated.");
}

var caseDuplicates = EmailSanitizer.NormalizeUnique(
[
    "TATUS.ENG@RELEVANTZ.COM",
    "tatus.eng@relevantz.com"
]);
if (caseDuplicates.Count != 1 || caseDuplicates[0] != "TATUS.ENG@RELEVANTZ.COM")
{
    throw new InvalidOperationException("Case-insensitive dedupe did not preserve first spelling.");
}

var tooLongLocalPart = $"{new string('a', 65)}@domain.com";
var tooLongAddress = $"{new string('a', 245)}@domain.com";
foreach (var invalid in new[]
         {
             "bad..name@domain.com",
             "bad.@domain.com",
             "user@domain.unknown",
             tooLongLocalPart,
             tooLongAddress
         })
{
    if (EmailSanitizer.Sanitize(invalid) is not null)
    {
        throw new InvalidOperationException($"Invalid address was accepted: '{invalid}'.");
    }
}

var adjacentText = EmailSanitizer.ExtractEmails(
    "consultants.futurehiremanpower@atomicmail.ioSubject\nchathurya@mechispike.comKnow");
if (!adjacentText.SequenceEqual(
        ["consultants.futurehiremanpower@atomicmail.io", "chathurya@mechispike.com"]))
{
    throw new InvalidOperationException("Adjacent text suffixes were not truncated correctly.");
}

Console.WriteLine($"Passed {cases.Count + 3} native-host email sanitizer tests.");
