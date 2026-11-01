// Official release assets: https://github.com/XTLS/Xray-core/releases/tag/v26.10.31
export const xrayRelease = {
  version: 'v26.10.31',
  assets: {
    x64: {
      fileName: 'Xray-linux-64.zip',
      sha256: 'e4bd9119f50ae7c41658b1abd0679ae06f98bd864a2907ff33f2f2cf7081b214'
    },
    arm64: {
      fileName: 'Xray-linux-arm64-v8a.zip',
      sha256: '1811c8f1da0c3b6dc707ebaf1c8390e987ba39859a8f0a7aadd8526157f2ec8d'
    }
  }
} as const

export function xrayArtifact(architecture: keyof typeof xrayRelease.assets) {
  const asset = xrayRelease.assets[architecture]
  return {
    url: `https://github.com/XTLS/Xray-core/releases/download/${xrayRelease.version}/${asset.fileName}`,
    sha256: asset.sha256,
    cacheName: `xray-${xrayRelease.version}-${architecture}-${asset.sha256}.zip`
  }
}
