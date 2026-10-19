// 字节工具：hex、拼接、大端整数、随机数、常量时间比较

export function hex(b: Uint8Array | null | undefined): string {
  if (!b) return ""
  let s: string = ""
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0")
  return s
}

export function unhex(s: string): Uint8Array {
  const clean: string = s.replace(/[^0-9a-fA-F]/g, "")
  const out: Uint8Array = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n: number = 0
  for (const p of parts) n += p.length
  const out: Uint8Array = new Uint8Array(n)
  let i: number = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

export function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
}

export function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 8) & 255, n & 255])
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function randomBytes(n: number): Uint8Array {
  const out: Uint8Array = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

/** 常量时间比较，防止时序侧信道 */
export function equalBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  let d: number = 0
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]
  return d === 0
}

/** 把 protobufjs 可能返回的 Buffer / number[] / 空值统一成独立的 Uint8Array */
export function toBytes(x: unknown): Uint8Array {
  if (x == null) return new Uint8Array(0)
  if (x instanceof Uint8Array) return new Uint8Array(x)
  if (Array.isArray(x)) return new Uint8Array(x as number[])
  if (typeof x === "string") return unhex(x)
  return new Uint8Array(0)
}

export function nonEmpty(x: unknown): boolean {
  return x instanceof Uint8Array ? x.length > 0 : Array.isArray(x) ? x.length > 0 : false
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((res: () => void) => setTimeout(res, ms))
}
