export function countCodeSearchResults(output?: string): number {
  if (!output) {
    return 0
  }

  const lines = output.split('\n')
  const matchCountLine = lines.find((line) =>
    /^Found \d+ match(?:es)?$/.test(line.trim()),
  )
  const parsedTotalResults = matchCountLine
    ?.trim()
    .match(/^Found (\d+) match(?:es)?$/)?.[1]

  if (parsedTotalResults !== undefined) {
    return Number(parsedTotalResults)
  }

  return lines.reduce((total, line) => {
    const trimmed = line.trim()
    return /^(?:Line\s+)?\d+:/.test(trimmed) ? total + 1 : total
  }, 0)
}
