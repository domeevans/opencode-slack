import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { Skill } from "@opencode/plugin"

type SkillInfo = typeof Skill.Info.Type

const SKILLS = ["slack-search"] as const

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/

/** Reads `name` and `description` from YAML-style frontmatter, tolerating CRLF line endings. */
export function parseSkill(id: string, path: string, text: string): SkillInfo | undefined {
  const match = FRONTMATTER.exec(text)
  if (match === null) return undefined
  const fields = new Map<string, string>()
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^([a-z]+):\s*(.*?)\s*$/.exec(line)
    if (field) fields.set(field[1]!, field[2]!.replace(/^(["'])(.*)\1$/, "$2"))
  }
  const description = fields.get("description")
  if (fields.get("name") !== id || !description) return undefined
  return {
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    description,
    path: Skill.Info.fields.path.make(path),
    content: match[2]!.trim(),
  }
}

/** Loads the skills shipped in the package's `skills/` folder. A missing skill means a broken install. */
export async function loadSkills(root = new URL("../skills/", import.meta.url)): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = []
  for (const id of SKILLS) {
    const path = fileURLToPath(new URL(`${id}/SKILL.md`, root))
    const text = await readFile(path, "utf8").catch(() => {
      throw new Error(`SKILLS_INVALID: Bundled skill ${id} is missing. Next step: Run opencode plugin update @joe-broadhead/opencode-slack, then opencode reload.`)
    })
    const skill = parseSkill(id, path, text)
    if (skill === undefined) throw new Error(`SKILLS_INVALID: Bundled skill ${id} has invalid frontmatter. Next step: Run opencode plugin update @joe-broadhead/opencode-slack, then opencode reload.`)
    skills.push(skill)
  }
  return skills
}

/** A skill as OpenCode lists it: its id and the file it was read from. */
export interface ListedSkill {
  readonly id: string
  readonly path: string
}

/**
 * The listed skills that carry a bundled skill's id but come from another file. OpenCode keeps one skill per id, and a
 * user's or a project's own skill wins, so the bundled one never loads.
 */
export function shadowedSkills(listed: readonly ListedSkill[], own: readonly ListedSkill[]): ListedSkill[] {
  return listed
    .filter((skill) => own.some((bundled) => bundled.id === skill.id && bundled.path !== skill.path))
    .map((skill) => ({ id: skill.id, path: skill.path }))
}
