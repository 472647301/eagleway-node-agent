export type SupportedOsId = 'ubuntu' | 'alinux'

export type HostProfile = 'ubuntu' | 'ubuntu-baota' | 'alinux' | 'alinux-baota'

export const HOST_PROFILES: readonly HostProfile[] = [
  'ubuntu',
  'ubuntu-baota',
  'alinux',
  'alinux-baota'
]

export function hostProfileFor(
  release: Record<string, string>,
  baota: boolean
): HostProfile | null {
  if (release.ID === 'ubuntu') return baota ? 'ubuntu-baota' : 'ubuntu'
  if (release.ID === 'alinux' && release.VERSION_ID === '3') {
    return baota ? 'alinux-baota' : 'alinux'
  }
  return null
}

export function hostProfileOsId(profile: HostProfile): SupportedOsId {
  return profile.startsWith('alinux') ? 'alinux' : 'ubuntu'
}

export function isBaotaHostProfile(profile: HostProfile): boolean {
  return profile.endsWith('-baota')
}
