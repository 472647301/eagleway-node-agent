export const XRAY_FIREWALL_COMMENT = 'eagleway-node-agent:xray'

export function ufwIsActive(output: string): boolean {
  return /^Status:\s+active\s*$/im.test(output)
}

export function ufwAllowsTcpPort(output: string, port: number): boolean {
  const target = new RegExp(
    `^(?:\\[\\s*\\d+\\]\\s*)?${port}\\/tcp(?:\\s+\\(v6\\))?\\s+ALLOW(?:\\s+IN)?\\b`,
    'i'
  )
  return output.split(/\r?\n/).some((line) => target.test(line.trim()))
}

export function ufwOwnedRuleNumbers(output: string, port: number): number[] {
  const target = new RegExp(
    `^\\[\\s*(\\d+)\\]\\s+${port}\\/tcp(?:\\s+\\(v6\\))?.*#\\s*${escapeRegExp(XRAY_FIREWALL_COMMENT)}\\s*$`,
    'i'
  )
  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = target.exec(line.trim())
      return match ? [Number(match[1])] : []
    })
    .sort((left, right) => right - left)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
