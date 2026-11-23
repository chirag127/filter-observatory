@{
  IncludeRules = @('PSUseConsistentIndentation', 'PSUseConsistentWhitespace', 'PSPlaceOpenBrace', 'PSPlaceCloseBrace')
  Rules = @{
    PSUseConsistentIndentation = @{ Enable = $true; Kind = 'space'; IndentationSize = 2 }
    PSUseConsistentWhitespace = @{ Enable = $true }
    PSPlaceOpenBrace = @{ Enable = $true; OnSameLine = $true }
    PSPlaceCloseBrace = @{ Enable = $true; NewLineAfter = $true }
  }
}
