// Official release assets: https://github.com/XTLS/Xray-core/releases/tag/v26.10.29
export const xrayRelease = {
  version: 'v26.10.29',
  assets: {
    x64: {
      fileName: 'Xray-linux-64.zip',
      sha256: '8a5f3e6a1057e4bd0f8a7c57c9d91204b4be0b74222a6e210d070603101163c2'
    },
    arm64: {
      fileName: 'Xray-linux-arm64-v8a.zip',
      sha256: 'afe01f19045b05237420328028ee1ee2e1edd2100eb41a8cbbf50e683b0a6e58'
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
