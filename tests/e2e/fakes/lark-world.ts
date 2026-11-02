/** The Feishu app the fake `lark-cli` impersonates, and its state directory. Erasable syntax only (see store.ts). */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LarkWorld {
  appId: string; botOpenId: string; botName: string; strictMode: string
  chats: { chat_id: string; name: string }[]
}
export const initialLarkWorld = (): LarkWorld => ({ appId: 'cli_e2efake', botOpenId: 'ou_e2ebot', botName: 'E2E Bot', strictMode: 'bot', chats: [] })
export function createLarkWorld(dir: string, world: LarkWorld): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(world, null, 2))
  for (const name of ['calls.jsonl', 'writes.jsonl', 'events.jsonl']) writeFileSync(join(dir, name), '')
}

