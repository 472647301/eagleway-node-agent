export const XRAY_PROTOCOLS = ['trojan', 'vless', 'vmess'] as const

export type XrayProtocol = (typeof XRAY_PROTOCOLS)[number]

export function isXrayProtocol(value: string): value is XrayProtocol {
  return XRAY_PROTOCOLS.includes(value as XrayProtocol)
}

export function inboundTag(protocol: XrayProtocol): string {
  return `eagleway-${protocol}`
}

export function runtimeUserId(
  protocol: XrayProtocol,
  assignmentId: string
): string {
  return `${protocol}.${assignmentId}@eagleway.internal`
}

export function assignmentIdFromRuntimeUserId(
  protocol: XrayProtocol,
  userId: string
): string | null {
  const prefix = `${protocol}.`
  const suffix = '@eagleway.internal'
  if (!userId.startsWith(prefix) || !userId.endsWith(suffix)) return null
  const assignmentId = userId.slice(prefix.length, -suffix.length)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    assignmentId
  )
    ? assignmentId
    : null
}
