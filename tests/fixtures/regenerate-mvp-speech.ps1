param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
# Run with Windows PowerShell 5.1 and the installed Microsoft Huihui Desktop voice.
# Creates a NEW directory; never overwrites approved media.
if (Test-Path -LiteralPath $OutputDirectory) { throw 'Output directory already exists; choose a fresh directory.' }
$fixtureOutput = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $fixtureOutput | Out-Null
$fixtureTextPath = Join-Path $PSScriptRoot 'mvp-project/narration.txt'
$fixtureText = [IO.File]::ReadAllText($fixtureTextPath, [Text.Encoding]::UTF8).TrimEnd("`r", "`n").Replace("`r`n", "`n")
Add-Type -AssemblyName System.Speech
$fixtureSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $fixtureSynth.SelectVoice('Microsoft Huihui Desktop')
  $fixtureSynth.Rate = 2
  $fixtureSynth.Volume = 100
  $fixtureSynth.SetOutputToWaveFile((Join-Path $fixtureOutput 'speech.wav'))
  $fixtureSynth.Speak($fixtureText)
} finally { $fixtureSynth.Dispose() }
[IO.File]::WriteAllText((Join-Path $fixtureOutput 'narration.txt'), $fixtureText, (New-Object Text.UTF8Encoding($false)))
$fixtureProvenance = [ordered]@{
  schemaVersion = 1
  providerId = 'windows-system-speech-fixture'
  model = 'System.Speech / Microsoft Huihui Desktop / zh-CN / rate 2'
  voiceId = 'Microsoft Huihui Desktop'
  voiceKind = 'synthetic'
  sourceKind = 'windows-built-in-synthetic'
  generatedAt = [DateTime]::UtcNow.ToString('o')
  narrationSha256 = (Get-FileHash -LiteralPath (Join-Path $fixtureOutput 'narration.txt') -Algorithm SHA256).Hash.ToLowerInvariant()
  audioSha256 = (Get-FileHash -LiteralPath (Join-Path $fixtureOutput 'speech.wav') -Algorithm SHA256).Hash.ToLowerInvariant()
  provenance = 'Locally synthesized from canonical original fixture text using an installed Windows built-in synthetic voice. No human recording, cloning, Jianying, OpenAI call, paid API, remote source, or publication.'
  rightsScope = 'Offline test and inspection only; not a claim of commercial redistribution clearance for Microsoft voice output.'
}
[IO.File]::WriteAllText((Join-Path $fixtureOutput 'speech-provenance.json'), ($fixtureProvenance | ConvertTo-Json -Depth 5).Replace("`r`n", "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Output $fixtureOutput
