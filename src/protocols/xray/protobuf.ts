export function protobufMessage(
  fields: Array<
    readonly [
      number,
      'string' | 'bytes' | 'message' | 'varint',
      string | Buffer | bigint
    ]
  >
): Buffer {
  const chunks: Buffer[] = []
  for (const [field, type, value] of fields) {
    if (type === 'varint') {
      chunks.push(varint(BigInt(field << 3)), varint(value as bigint))
      continue
    }
    const data =
      type === 'string'
        ? Buffer.from(value as string, 'utf8')
        : (value as Buffer)
    chunks.push(
      varint(BigInt((field << 3) | 2)),
      varint(BigInt(data.length)),
      data
    )
  }
  return Buffer.concat(chunks)
}

export interface ProtobufField {
  number: number
  wireType: number
  value: bigint | Buffer
}

export function protobufFields(input: Buffer): ProtobufField[] {
  const fields: ProtobufField[] = []
  let offset = 0
  while (offset < input.length) {
    const key = readVarint(input, offset)
    offset = key.offset
    const number = Number(key.value >> 3n)
    const wireType = Number(key.value & 7n)
    if (wireType === 0) {
      const value = readVarint(input, offset)
      offset = value.offset
      fields.push({ number, wireType, value: value.value })
    } else if (wireType === 1) {
      if (offset + 8 > input.length) throw new Error('Invalid protobuf field')
      fields.push({
        number,
        wireType,
        value: input.subarray(offset, offset + 8)
      })
      offset += 8
    } else if (wireType === 2) {
      const length = readVarint(input, offset)
      offset = length.offset
      const size = Number(length.value)
      if (!Number.isSafeInteger(size) || offset + size > input.length) {
        throw new Error('Invalid protobuf field')
      }
      fields.push({
        number,
        wireType,
        value: input.subarray(offset, offset + size)
      })
      offset += size
    } else if (wireType === 5) {
      if (offset + 4 > input.length) throw new Error('Invalid protobuf field')
      fields.push({
        number,
        wireType,
        value: input.subarray(offset, offset + 4)
      })
      offset += 4
    } else {
      throw new Error('Unsupported protobuf wire type')
    }
  }
  return fields
}

export function stringField(input: Buffer, number: number): string | null {
  const field = protobufFields(input).find(
    (item) => item.number === number && item.wireType === 2
  )
  return Buffer.isBuffer(field?.value) ? field.value.toString('utf8') : null
}

export function varintField(input: Buffer, number: number): bigint | null {
  const field = protobufFields(input).find(
    (item) => item.number === number && item.wireType === 0
  )
  return typeof field?.value === 'bigint' ? field.value : null
}

function varint(value: bigint): Buffer {
  if (value < 0n) throw new Error('Negative varints are unsupported')
  const bytes: number[] = []
  do {
    let byte = Number(value & 0x7fn)
    value >>= 7n
    if (value) byte |= 0x80
    bytes.push(byte)
  } while (value)
  return Buffer.from(bytes)
}

function readVarint(
  input: Buffer,
  start: number
): { value: bigint; offset: number } {
  let value = 0n
  let shift = 0n
  let offset = start
  while (offset < input.length && shift <= 63n) {
    const byte = input[offset++]!
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, offset }
    shift += 7n
  }
  throw new Error('Invalid protobuf varint')
}
