#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$UAsset,

    [string]$Project,
    [string]$Engine,
    [string]$AssetPath,
    [string]$Output,
    [switch]$LoadAsset,
    [switch]$ResolveOnly,
    [ValidateSet('replace_variable_references', 'upgrade_operator_nodes', 'remove_unused_nodes')]
    [string]$BlueprintAction,
    [string]$OldVariableName,
    [string]$NewVariableName,
    [switch]$ConfirmWrite,

    [ValidateRange(30, 3600)]
    [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Resolve-RequiredFile {
    param([string]$Value, [string]$Label)

    if (-not (Test-Path -LiteralPath $Value -PathType Leaf)) {
        throw "$Label does not exist: $Value"
    }
    return (Get-Item -LiteralPath $Value).FullName
}

function Resolve-ProjectFile {
    param([string]$ProjectValue, [string]$AssetFile)

    if ($ProjectValue) {
        if (Test-Path -LiteralPath $ProjectValue -PathType Container) {
            $projects = @(Get-ChildItem -LiteralPath $ProjectValue -File -Filter '*.uproject')
            if ($projects.Count -ne 1) {
                throw "Project directory must contain exactly one .uproject: $ProjectValue"
            }
            return $projects[0].FullName
        }
        return Resolve-RequiredFile $ProjectValue 'Project file'
    }

    $directory = (Get-Item -LiteralPath $AssetFile).Directory
    while ($null -ne $directory) {
        $projects = @(Get-ChildItem -LiteralPath $directory.FullName -File -Filter '*.uproject')
        if ($projects.Count -eq 1) {
            return $projects[0].FullName
        }
        if ($projects.Count -gt 1) {
            throw "Multiple .uproject files found in $($directory.FullName); pass -Project explicitly."
        }
        $directory = $directory.Parent
    }
    throw "No .uproject was found above $AssetFile; pass -Project explicitly."
}

function Get-EditorCommandFromRoot {
    param([string]$Root)

    if (-not $Root) { return $null }
    if (Test-Path -LiteralPath $Root -PathType Leaf) {
        $leaf = Split-Path -Leaf $Root
        if ($leaf -in @('UnrealEditor-Cmd.exe', 'UE4Editor-Cmd.exe')) {
            return (Get-Item -LiteralPath $Root).FullName
        }
        return $null
    }

    foreach ($candidate in @(
        (Join-Path $Root 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'),
        (Join-Path $Root 'Engine\Binaries\Win64\UE4Editor-Cmd.exe'),
        (Join-Path $Root 'Binaries\Win64\UnrealEditor-Cmd.exe'),
        (Join-Path $Root 'Binaries\Win64\UE4Editor-Cmd.exe')
    )) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
    return $null
}

function Get-RegisteredEngines {
    $results = @()
    $customKey = Get-ItemProperty 'HKCU:\Software\Epic Games\Unreal Engine\Builds' -ErrorAction SilentlyContinue
    if ($null -ne $customKey) {
        foreach ($property in $customKey.PSObject.Properties) {
            if ($property.Name.StartsWith('PS')) { continue }
            $editor = Get-EditorCommandFromRoot ([string]$property.Value)
            if ($editor) {
                $results += [pscustomobject]@{ Association = $property.Name; Editor = $editor }
            }
        }
    }

    foreach ($baseKey in @(
        'HKLM:\SOFTWARE\EpicGames\Unreal Engine',
        'HKLM:\SOFTWARE\WOW6432Node\EpicGames\Unreal Engine'
    )) {
        foreach ($versionKey in @(Get-ChildItem $baseKey -ErrorAction SilentlyContinue)) {
            $data = Get-ItemProperty $versionKey.PSPath -ErrorAction SilentlyContinue
            $editor = Get-EditorCommandFromRoot ([string]$data.InstalledDirectory)
            if ($editor) {
                $results += [pscustomobject]@{ Association = $versionKey.PSChildName; Editor = $editor }
            }
        }
    }

    $commonRoot = 'C:\Program Files\Epic Games'
    foreach ($directory in @(Get-ChildItem -LiteralPath $commonRoot -Directory -Filter 'UE_*' -ErrorAction SilentlyContinue)) {
        $editor = Get-EditorCommandFromRoot $directory.FullName
        if ($editor) {
            $results += [pscustomobject]@{
                Association = $directory.Name.Substring(3)
                Editor = $editor
            }
        }
    }

    return @($results | Group-Object Editor | ForEach-Object { $_.Group[0] })
}

function Resolve-EditorCommand {
    param([string]$EngineValue, [string]$ProjectFile)

    if ($EngineValue -and (Test-Path -LiteralPath $EngineValue)) {
        $editor = Get-EditorCommandFromRoot $EngineValue
        if (-not $editor) { throw "No Unreal command editor was found under: $EngineValue" }
        return $editor
    }

    $projectData = Get-Content -LiteralPath $ProjectFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $association = if ($EngineValue) { $EngineValue } else { [string]$projectData.EngineAssociation }
    $engines = @(Get-RegisteredEngines)

    if ($association) {
        $normalized = $association -replace '^UE_', ''
        $matches = @($engines | Where-Object {
            $_.Association -ieq $association -or $_.Association -ieq $normalized
        })
        if ($matches.Count -eq 1) { return $matches[0].Editor }
        if ($matches.Count -gt 1) {
            throw "Engine association '$association' resolves to multiple editors; pass an explicit engine root."
        }
        $available = ($engines | ForEach-Object { "$($_.Association) => $($_.Editor)" }) -join '; '
        throw "Engine association '$association' is not installed. Available: $available"
    }

    if ($engines.Count -eq 1) { return $engines[0].Editor }
    $available = ($engines | ForEach-Object { "$($_.Association) => $($_.Editor)" }) -join '; '
    throw "The project has no EngineAssociation and engine selection is ambiguous. Pass -Engine. Available: $available"
}

function Get-RelativePathUnderRoot {
    param([string]$File, [string]$Root)

    $fileFull = [IO.Path]::GetFullPath($File)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/')
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $fileFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        return $null
    }
    return $fileFull.Substring($prefix.Length)
}

function Normalize-PackageName {
    param([string]$Value)

    $result = $Value.Trim()
    if ($result -match "^[^']+'(?<Path>/[^']+)'$") {
        $result = $Matches.Path
    }
    if (-not $result.StartsWith('/')) {
        throw "AssetPath must be a virtual Unreal path beginning with '/': $Value"
    }
    $lastSlash = $result.LastIndexOf('/')
    $objectSeparator = $result.IndexOf('.', $lastSlash)
    if ($objectSeparator -gt $lastSlash) {
        $result = $result.Substring(0, $objectSeparator)
    }
    return $result.TrimEnd('/')
}

function Resolve-PackageName {
    param([string]$AssetFile, [string]$ProjectFile, [string]$ExplicitAssetPath)

    if ($ExplicitAssetPath) { return Normalize-PackageName $ExplicitAssetPath }

    $projectDirectory = Split-Path -Parent $ProjectFile
    $relative = Get-RelativePathUnderRoot $AssetFile (Join-Path $projectDirectory 'Content')
    if ($null -ne $relative) {
        $withoutExtension = $relative.Substring(0, $relative.Length - [IO.Path]::GetExtension($relative).Length)
        return '/Game/' + ($withoutExtension -replace '\\', '/')
    }

    $pluginsDirectory = Join-Path $projectDirectory 'Plugins'
    foreach ($descriptor in @(Get-ChildItem -LiteralPath $pluginsDirectory -File -Recurse -Filter '*.uplugin' -ErrorAction SilentlyContinue)) {
        $pluginRoot = Split-Path -Parent $descriptor.FullName
        $relative = Get-RelativePathUnderRoot $AssetFile (Join-Path $pluginRoot 'Content')
        if ($null -ne $relative) {
            $mount = [IO.Path]::GetFileNameWithoutExtension($descriptor.Name)
            $withoutExtension = $relative.Substring(0, $relative.Length - [IO.Path]::GetExtension($relative).Length)
            return '/' + $mount + '/' + ($withoutExtension -replace '\\', '/')
        }
    }

    throw "The asset is outside project/plugin Content. Pass its mounted virtual path with -AssetPath."
}

function Get-UAssetFileInfo {
    param([string]$AssetFile)

    $stream = [IO.File]::Open($AssetFile, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
        $bytes = New-Object byte[] 4
        $read = $stream.Read($bytes, 0, 4)
    } finally {
        $stream.Dispose()
    }
    $tag = if ($read -eq 4) { ($bytes | ForEach-Object { $_.ToString('X2') }) -join '' } else { '' }
    $base = [IO.Path]::Combine(
        [IO.Path]::GetDirectoryName($AssetFile),
        [IO.Path]::GetFileNameWithoutExtension($AssetFile)
    )
    $sidecars = @()
    foreach ($extension in @('.uexp', '.ubulk', '.uptnl')) {
        $candidate = $base + $extension
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $item = Get-Item -LiteralPath $candidate
            $sidecars += [pscustomobject]@{ Path = $item.FullName; SizeBytes = $item.Length }
        }
    }
    $item = Get-Item -LiteralPath $AssetFile
    return [pscustomobject]@{
        Path = $item.FullName
        SizeBytes = $item.Length
        PackageTagHex = $tag
        RecognizedPackageTag = $tag -in @('C1832A9E', '9E2A83C1')
        Sidecars = $sidecars
    }
}

function Quote-NativeArgument {
    param([string]$Value)
    if ($Value.Contains('"')) { throw "Native argument contains an unsupported quote: $Value" }
    return '"' + $Value + '"'
}

function Remove-TemporaryFile {
    param([string]$Path)

    if (-not $Path) { return }
    for ($attempt = 0; $attempt -lt 5; $attempt++) {
        if (-not (Test-Path -LiteralPath $Path)) { return }
        try {
            Remove-Item -LiteralPath $Path -Force
            return
        } catch {
            if ($attempt -eq 4) {
                Write-Warning "Could not remove temporary file: $Path"
                return
            }
            Start-Sleep -Milliseconds 100
        }
    }
}

$assetFile = Resolve-RequiredFile $UAsset 'uasset file'
if ([IO.Path]::GetExtension($assetFile) -ine '.uasset') {
    throw "Expected a .uasset file: $assetFile"
}
$isBlueprintEdit = -not [string]::IsNullOrWhiteSpace($BlueprintAction)
if ($isBlueprintEdit -and -not $ConfirmWrite) {
    throw '-ConfirmWrite is required for Blueprint mutations.'
}
if ($BlueprintAction -eq 'replace_variable_references') {
    if ([string]::IsNullOrWhiteSpace($OldVariableName) -or [string]::IsNullOrWhiteSpace($NewVariableName)) {
        throw 'replace_variable_references requires -OldVariableName and -NewVariableName.'
    }
    if ($OldVariableName -eq $NewVariableName) {
        throw 'OldVariableName and NewVariableName must be different.'
    }
}
$projectFile = Resolve-ProjectFile $Project $assetFile
$packageName = Resolve-PackageName $assetFile $projectFile $AssetPath
$editorCommand = Resolve-EditorCommand $Engine $projectFile
$fileInfo = Get-UAssetFileInfo $assetFile
$pythonScriptName = if ($isBlueprintEdit) { 'blueprint_python_editor.py' } else { 'ue_asset_inspector.py' }
$inspectorScript = Join-Path $PSScriptRoot $pythonScriptName
$inspectorScript = Resolve-RequiredFile $inspectorScript 'Bundled Unreal Python script'

if ($ResolveOnly) {
    [pscustomobject]@{
        Project = $projectFile
        EngineCommand = $editorCommand
        PackageName = $packageName
        UAsset = $fileInfo
        InspectorScript = $inspectorScript
        BlueprintAction = $(if ($isBlueprintEdit) { $BlueprintAction } else { $null })
    } | ConvertTo-Json -Depth 8
    return
}

$temporaryReport = -not $Output
$reportFile = if ($Output) {
    [IO.Path]::GetFullPath($Output)
} else {
    Join-Path ([IO.Path]::GetTempPath()) ("ue-uasset-report-{0}.json" -f [guid]::NewGuid())
}
$reportDirectory = [IO.Path]::GetDirectoryName($reportFile)
if ($reportDirectory -and -not [IO.Directory]::Exists($reportDirectory)) {
    [void][IO.Directory]::CreateDirectory($reportDirectory)
}
if (Test-Path -LiteralPath $reportFile -PathType Leaf) {
    [IO.File]::Delete($reportFile)
}

$backupInfo = $null
if ($isBlueprintEdit) {
    $projectDirectory = Split-Path -Parent $projectFile
    $backupDirectory = Join-Path $projectDirectory (
        'Saved\DSHUEAssetsOperator\Backups\{0}-{1}' -f `
            (Get-Date -Format 'yyyyMMdd-HHmmss'), [guid]::NewGuid().ToString('N')
    )
    [void][IO.Directory]::CreateDirectory($backupDirectory)
    $backupFiles = @()
    foreach ($sourcePath in @($fileInfo.Path) + @($fileInfo.Sidecars | ForEach-Object { $_.Path })) {
        $destinationPath = Join-Path $backupDirectory ([IO.Path]::GetFileName($sourcePath))
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
        $backupFiles += $destinationPath
    }
    $backupInfo = [pscustomobject]@{
        directory = $backupDirectory
        files = $backupFiles
    }
}

$process = $null
$environmentNames = @(
    'UE_UASSET_INSPECT_FILE',
    'UE_UASSET_INSPECT_PACKAGE',
    'UE_UASSET_INSPECT_OUTPUT',
    'UE_UASSET_INSPECT_LOAD',
    'UE_BP_PY_ACTION',
    'UE_BP_PY_OLD_VARIABLE',
    'UE_BP_PY_NEW_VARIABLE'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    [Environment]::SetEnvironmentVariable('UE_UASSET_INSPECT_FILE', $assetFile, 'Process')
    [Environment]::SetEnvironmentVariable('UE_UASSET_INSPECT_PACKAGE', $packageName, 'Process')
    [Environment]::SetEnvironmentVariable('UE_UASSET_INSPECT_OUTPUT', $reportFile, 'Process')
    [Environment]::SetEnvironmentVariable('UE_UASSET_INSPECT_LOAD', $(if ($LoadAsset) { '1' } else { '0' }), 'Process')
    [Environment]::SetEnvironmentVariable('UE_BP_PY_ACTION', $(if ($isBlueprintEdit) { $BlueprintAction } else { $null }), 'Process')
    [Environment]::SetEnvironmentVariable('UE_BP_PY_OLD_VARIABLE', $(if ($isBlueprintEdit) { $OldVariableName } else { $null }), 'Process')
    [Environment]::SetEnvironmentVariable('UE_BP_PY_NEW_VARIABLE', $(if ($isBlueprintEdit) { $NewVariableName } else { $null }), 'Process')

    $ddcArguments = @('-DDC-ForceMemoryCache')
    if ((Split-Path -Leaf $editorCommand) -ieq 'UnrealEditor-Cmd.exe') {
        $ddcArguments += '-ddc=InstalledNoZenLocalFallback'
    }

    $arguments = @(
        (Quote-NativeArgument $projectFile),
        '-run=pythonscript',
        ('-script=' + (Quote-NativeArgument $inspectorScript)),
        '-unattended',
        '-nop4',
        '-nosplash',
        '-nullrhi',
        '-NoSound'
    )
    $arguments += $ddcArguments
    $arguments += @(
        '-stdout',
        '-FullStdOutLogOutput',
        '-UTF8Output'
    )
    $argumentLine = $arguments -join ' '

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $editorCommand
    $startInfo.Arguments = $argumentLine
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $startInfo.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw "Failed to start Unreal command editor: $editorCommand"
    }
    $standardOutputTask = $process.StandardOutput.ReadToEndAsync()
    $standardErrorTask = $process.StandardError.ReadToEndAsync()

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $process.Kill()
        [void]$process.WaitForExit(5000)
        throw "Unreal operation exceeded $TimeoutSeconds seconds and was stopped."
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
    $standardError = $standardErrorTask.GetAwaiter().GetResult()
    $process.Dispose()
    $process = $null
    $logTail = ((@($standardOutput, $standardError) -join [Environment]::NewLine) -split '\r?\n' | Select-Object -Last 80) -join [Environment]::NewLine

    if (-not (Test-Path -LiteralPath $reportFile -PathType Leaf)) {
        throw "Unreal did not create the JSON report (exit $exitCode).`n$logTail"
    }

    $jsonText = Get-Content -LiteralPath $reportFile -Raw -Encoding UTF8
    $report = $jsonText | ConvertFrom-Json
    if ($null -ne $backupInfo) {
        $report | Add-Member -NotePropertyName backup -NotePropertyValue $backupInfo -Force
    }
    if (-not $report.success) {
        $backupNote = if ($null -ne $backupInfo) { "`nBackup: $($backupInfo.directory)" } else { '' }
        throw "Unreal operation failed (exit $exitCode): $($report.error)$backupNote`n$logTail"
    }

    $report | Add-Member -NotePropertyName wrapper_process -NotePropertyValue ([pscustomobject]@{
        exit_code = $exitCode
        clean_exit = $exitCode -eq 0
    }) -Force
    $jsonText = $report | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($reportFile, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
    if ($exitCode -ne 0) {
        Write-Warning "Unreal returned exit $exitCode after creating a successful inspection report; see wrapper_process and the project log."
    }
    Write-Output $jsonText
} finally {
    if ($null -ne $process) {
        $process.Dispose()
    }
    foreach ($name in $environmentNames) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    if ($temporaryReport) {
        Remove-TemporaryFile $reportFile
    }
}
