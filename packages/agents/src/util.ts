export const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
export const randRange = (min: number, max: number) => min + Math.random() * (max - min)
export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const ts = () => new Date().toISOString().substring(11, 19)

export const log = (agent: string, msg: string) => {
  console.log(`[${ts()}] [${agent}] ${msg}`)
}

export const logGlobal = (msg: string) => {
  console.log(`[${ts()}] [SWARM] ${msg}`)
}
