# Windows' built-in speech recogniser for voice commands (src/voice.js). Offline; it's the old
# desktop engine, so US English only. Line protocol over stdin/stdout, JSON one per line:
#   first line in:  {phrases: [{say, means}], freeText: ["inspo", ...]}
#   then each line: {id, wav: base64 16 kHz mono WAV}  ->  {id, texts: [best, ...]} or {id, error}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$out = [Console]::Out
function Send($o) { $out.WriteLine(($o | ConvertTo-Json -Compress)); $out.Flush() }

$info = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() |
  Sort-Object { $_.Culture.Name -ne 'en-US' } | Select-Object -First 1
if (-not $info) { [Console]::Error.WriteLine('Windows has no speech recogniser installed'); exit 1 }
$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)

$setup = [Console]::In.ReadLine() | ConvertFrom-Json
# The commands, each returning the text parseCommand understands ("iso eight hundred" -> "iso 800").
$choices = New-Object System.Speech.Recognition.Choices
foreach ($p in $setup.phrases) {
  $choices.Add((New-Object System.Speech.Recognition.SemanticResultValue($p.say, $p.means)).ToGrammarBuilder())
}
$gb = New-Object System.Speech.Recognition.GrammarBuilder($choices)
$gb.Culture = $info.Culture
$engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($gb)))
# Reference photo requests: a lead word, then anything.
foreach ($lead in $setup.freeText) {
  $g = New-Object System.Speech.Recognition.GrammarBuilder($lead)
  $g.Culture = $info.Culture
  $g.AppendDictation()
  $engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($g)))
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  $req = $line | ConvertFrom-Json
  try {
    $engine.SetInputToWaveStream((New-Object IO.MemoryStream(, [Convert]::FromBase64String($req.wav))))
    $r = $engine.Recognize()
    $texts = @()
    if ($r) {
      foreach ($a in $r.Alternates) {
        if ($a.Confidence -lt 0.3) { continue }
        $texts += if ($a.Semantics.Value) { [string]$a.Semantics.Value } else { $a.Text }
      }
    }
    Send @{ id = $req.id; texts = @($texts | Select-Object -Unique) }
  } catch {
    Send @{ id = $req.id; error = $_.Exception.Message }
  }
}
