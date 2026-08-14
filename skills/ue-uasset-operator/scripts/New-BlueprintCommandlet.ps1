[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Container })]
    [string]$EditorModuleRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z][A-Za-z0-9_]*$')]
    [string]$CommandletName,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Z][A-Z0-9_]*_API$')]
    [string]$ModuleApi
)

$ErrorActionPreference = 'Stop'

$templateRoot = Join-Path $PSScriptRoot '..\assets\commandlet'
$headerTemplate = Join-Path $templateRoot 'BlueprintCommandlet.h.template'
$sourceTemplate = Join-Path $templateRoot 'BlueprintCommandlet.cpp.template'
$publicRoot = Join-Path $EditorModuleRoot 'Public\GeneratedCommandlets'
$privateRoot = Join-Path $EditorModuleRoot 'Private\GeneratedCommandlets'
$headerPath = Join-Path $publicRoot "$($CommandletName)Commandlet.h"
$sourcePath = Join-Path $privateRoot "$($CommandletName)Commandlet.cpp"

foreach ($template in @($headerTemplate, $sourceTemplate)) {
    if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
        throw "Missing bundled scaffold template: $template"
    }
}

foreach ($target in @($headerPath, $sourcePath)) {
    if (Test-Path -LiteralPath $target) {
        throw "Refusing to overwrite existing file: $target"
    }
}

if (-not $PSCmdlet.ShouldProcess($EditorModuleRoot, "Create $CommandletName Commandlet scaffold")) {
    return
}

New-Item -ItemType Directory -Path $publicRoot -Force | Out-Null
New-Item -ItemType Directory -Path $privateRoot -Force | Out-Null

function Expand-CommandletTemplate {
    param([Parameter(Mandatory = $true)][string]$Path)

    $content = Get-Content -Raw -LiteralPath $Path
    $content = $content.Replace('{{COMMANDLET_NAME}}', $CommandletName)
    return $content.Replace('{{MODULE_API}}', $ModuleApi)
}

$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($headerPath, (Expand-CommandletTemplate $headerTemplate), $utf8WithoutBom)
[System.IO.File]::WriteAllText($sourcePath, (Expand-CommandletTemplate $sourceTemplate), $utf8WithoutBom)

[ordered]@{
    success = $true
    commandlet_name = $CommandletName
    header = $headerPath
    source = $sourcePath
    apply_implemented = $false
    next_reference = 'references/blueprint-commandlet-workflow.md'
} | ConvertTo-Json -Depth 4
