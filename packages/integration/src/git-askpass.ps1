$prompt = [string]$args[0]
if ($prompt -ceq "Username for 'https://github.com': ") {
  [Console]::Out.WriteLine('x-access-token')
  exit 0
}
if (($prompt -ceq "Password for 'https://github.com': " -or $prompt -ceq "Password for 'https://x-access-token@github.com': ") -and $env:ORLOOM_GIT_UPLOAD_TOKEN) {
  [Console]::Out.WriteLine($env:ORLOOM_GIT_UPLOAD_TOKEN)
  exit 0
}
exit 1
