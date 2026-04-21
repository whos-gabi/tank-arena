param(
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:UserAgent = "TankArenaMaterialUpdater"
$script:SourceUrl = "https://cs.unibuc.ro/~cechirita/tnm/"

function Write-Status {
    param([string]$Message)

    if (-not $Quiet) {
        Write-Host "[material] $Message"
    }
}

function Get-RemoteText {
    param([string]$Url)

    (Invoke-WebRequest -UseBasicParsing -Headers @{ "User-Agent" = $script:UserAgent } -Uri $Url).Content
}

function Save-RemoteFile {
    param(
        [string]$Url,
        [string]$Destination
    )

    $directory = Split-Path -Parent $Destination
    if ($directory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }

    Invoke-WebRequest -UseBasicParsing -Headers @{ "User-Agent" = $script:UserAgent } -Uri $Url -OutFile $Destination
}

function Get-UniqueMaterialLinks {
    param([string]$Html)

    $regex = [regex]'<a[^>]+href="(?<href>[^"]+)"[^>]*>(?<text>.*?)</a>'
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    $results = New-Object System.Collections.Generic.List[object]

    foreach ($match in $regex.Matches($Html)) {
        $href = $match.Groups["href"].Value.Trim()
        if (-not $href) {
            continue
        }

        $text = [System.Net.WebUtility]::HtmlDecode($match.Groups["text"].Value)
        $text = ($text -replace "<.*?>", "").Trim()

        if ($href -match '/tnm/c(?<id>\d+)/?$') {
            $key = "course:$($Matches["id"])"
            if ($seen.Add($key)) {
                $courseUrl = ([System.Uri]::new([System.Uri]$script:SourceUrl, $href)).AbsoluteUri
                if (-not $courseUrl.EndsWith("/")) {
                    $courseUrl = "$courseUrl/"
                }
                $results.Add([pscustomobject]@{
                    kind = "course"
                    slug = "c$($Matches["id"])"
                    title = $text
                    url = $courseUrl
                })
            }
            continue
        }

        if ($href -match 'github\.com/(?<owner>[^/]+)/(?<repo>[^/]+)/tree/(?<ref>[^/]+)/(?<path>.+)$') {
            $owner = $Matches["owner"]
            $repo = $Matches["repo"]
            $ref = $Matches["ref"]
            $path = [System.Uri]::UnescapeDataString($Matches["path"])
            if ($text -match 'l#(?<id>\d+)') {
                $slug = "l$($Matches["id"])"
                $key = "lab:$slug"
                if ($seen.Add($key)) {
                    $results.Add([pscustomobject]@{
                        kind = "lab"
                        slug = $slug
                        title = $text
                        url = $href
                        owner = $owner
                        repo = $repo
                        ref = $ref
                        path = $path
                    })
                }
            }
        }
    }

    $results
}

function Get-RelativeAssetRefs {
    param([string]$Html)

    $regex = [regex]'(?:href|src)=["''](?<ref>[^"'']+)["'']'
    $refs = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($match in $regex.Matches($Html)) {
        $ref = $match.Groups["ref"].Value.Trim()
        if (
            -not $ref -or
            $ref.StartsWith("#") -or
            $ref.StartsWith("data:") -or
            $ref.StartsWith("mailto:") -or
            $ref.StartsWith("javascript:") -or
            $ref.StartsWith("//") -or
            $ref -match '^[a-zA-Z]+://'
        ) {
            continue
        }

        if ($ref.Contains("..")) {
            continue
        }

        [void]$refs.Add($ref)
    }

    @($refs)
}

function Sync-CoursePage {
    param(
        [pscustomobject]$Course,
        [string]$DestinationRoot
    )

    $destDir = Join-Path $DestinationRoot $Course.slug
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null

    Write-Status "Downloading course $($Course.slug) from $($Course.url)"
    $html = Get-RemoteText -Url $Course.url
    $htmlPath = Join-Path $destDir "index.html"
    Set-Content -Path $htmlPath -Encoding UTF8 -Value $html

    $courseUri = [System.Uri]$Course.url
    foreach ($ref in Get-RelativeAssetRefs -Html $html) {
        $assetUri = [System.Uri]::new($courseUri, $ref)
        $normalizedRef = ($ref -replace '/', [System.IO.Path]::DirectorySeparatorChar)
        $assetDest = Join-Path $destDir $normalizedRef
        Save-RemoteFile -Url $assetUri.AbsoluteUri -Destination $assetDest
    }
}

function Get-GitHubContents {
    param(
        [string]$Owner,
        [string]$Repo,
        [string]$Ref,
        [string]$Path
    )

    $encodedPath = [System.Uri]::EscapeDataString($Path) -replace '%2F', '/'
    $url = "https://api.github.com/repos/$Owner/$Repo/contents/${encodedPath}?ref=$Ref"
    $response = Invoke-RestMethod -Headers @{ "User-Agent" = $script:UserAgent } -Uri $url

    if ($response -is [System.Array]) {
        return $response
    }

    if ($response.PSObject.Properties.Name -contains "type") {
        return @($response)
    }

    if ($response.PSObject.Properties.Name -contains "value") {
        return @($response.value)
    }

    throw "Unexpected GitHub API response for $Path"
}

function Sync-GitHubDirectory {
    param(
        [string]$Owner,
        [string]$Repo,
        [string]$Ref,
        [string]$Path,
        [string]$Destination
    )

    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    $items = Get-GitHubContents -Owner $Owner -Repo $Repo -Ref $Ref -Path $Path

    foreach ($item in $items) {
        $target = Join-Path $Destination $item.name
        if ($item.type -eq "dir") {
            Sync-GitHubDirectory -Owner $Owner -Repo $Repo -Ref $Ref -Path $item.path -Destination $target
            continue
        }

        if ($item.type -eq "file" -and $item.download_url) {
            Save-RemoteFile -Url $item.download_url -Destination $target
        }
    }
}

function Sync-LabFolder {
    param(
        [pscustomobject]$Lab,
        [string]$DestinationRoot
    )

    $destDir = Join-Path $DestinationRoot $Lab.slug
    Write-Status "Downloading lab $($Lab.slug) from GitHub path '$($Lab.path)'"
    Sync-GitHubDirectory -Owner $Lab.owner -Repo $Lab.repo -Ref $Lab.ref -Path $Lab.path -Destination $destDir
}

$materialRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$coursesRoot = Join-Path $materialRoot "courses"
$labsRoot = Join-Path $materialRoot "labs"
$sourceIndexPath = Join-Path $materialRoot "source-index.html"
$manifestPath = Join-Path $materialRoot "manifest.json"

New-Item -ItemType Directory -Force -Path $coursesRoot, $labsRoot | Out-Null

Write-Status "Fetching source page $script:SourceUrl"
$indexHtml = Get-RemoteText -Url $script:SourceUrl
Set-Content -Path $sourceIndexPath -Encoding UTF8 -Value $indexHtml

$materials = Get-UniqueMaterialLinks -Html $indexHtml
$courses = @($materials | Where-Object { $_.kind -eq "course" } | Sort-Object slug)
$labs = @($materials | Where-Object { $_.kind -eq "lab" } | Sort-Object slug)

foreach ($course in $courses) {
    Sync-CoursePage -Course $course -DestinationRoot $coursesRoot
}

foreach ($lab in $labs) {
    Sync-LabFolder -Lab $lab -DestinationRoot $labsRoot
}

$manifest = [pscustomobject]@{
    sourceUrl = $script:SourceUrl
    updatedAt = (Get-Date).ToString("o")
    courses = $courses
    labs = $labs
}

$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Status "Done. Courses: $($courses.Count), Labs: $($labs.Count)"
