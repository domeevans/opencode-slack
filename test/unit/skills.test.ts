import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { loadSkills, parseSkill } from "../../src/skills.js"

const REPO = fileURLToPath(new URL("../..", import.meta.url))
const SEARCH = readFileSync(join(REPO, "skills", "slack-search", "SKILL.md"), "utf8")
const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n")

mkdirSync(join(REPO, ".tmp"), { recursive: true })
const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A skills folder holding the given SKILL.md files, as a directory URL. */
function folder(skills: Readonly<Record<string, string>>): URL {
  const root = mkdtempSync(join(REPO, ".tmp", "skills-"))
  roots.push(root)
  for (const [id, text] of Object.entries(skills)) {
    mkdirSync(join(root, id))
    writeFileSync(join(root, id, "SKILL.md"), text)
  }
  return pathToFileURL(`${root}/`)
}

describe("parseSkill", () => {
  const text = "---\nname: slack-search\ndescription: Search Slack.\n---\n\n# Search\n\nBody.\n"

  test("reads name and description and keeps the body", () => {
    expect(parseSkill("slack-search", "/skills/slack-search/SKILL.md", text)).toEqual({
      id: "slack-search",
      name: "slack-search",
      description: "Search Slack.",
      path: "/skills/slack-search/SKILL.md",
      content: "# Search\n\nBody.",
    } as never)
  })

  test("CRLF gives the same skill", () => {
    const lf = parseSkill("slack-search", "/p", text)
    const fromCrlf = parseSkill("slack-search", "/p", crlf(text))
    expect(fromCrlf).toEqual({ ...lf!, content: crlf(lf!.content) })
  })

  test.each([
    ["double quotes", 'description: "Search Slack: find, read, cite."', "Search Slack: find, read, cite."],
    ["single quotes", "description: 'Search Slack.'", "Search Slack."],
    ["trailing spaces", "description: Search Slack.   ", "Search Slack."],
  ])("unquotes a description with %s", (_label, line, description) => {
    expect(parseSkill("slack-search", "/p", `---\nname: slack-search\n${line}\n---\nBody`)?.description).toBe(description)
  })

  test("accepts frontmatter that ends the file", () => {
    expect(parseSkill("slack-search", "/p", "---\nname: slack-search\ndescription: d\n---")).toMatchObject({ content: "" })
  })

  test.each([
    ["no frontmatter", "# Search\n"],
    ["unclosed frontmatter", "---\nname: slack-search\ndescription: d\n"],
    ["frontmatter not at the start", "\n---\nname: slack-search\ndescription: d\n---\n"],
    ["another name", "---\nname: slack-other\ndescription: d\n---\n"],
    ["no name", "---\ndescription: d\n---\n"],
    ["no description", "---\nname: slack-search\n---\n"],
    ["an empty description", "---\nname: slack-search\ndescription:\n---\n"],
  ])("rejects %s", (_label, text) => {
    expect(parseSkill("slack-search", "/p", text)).toBeUndefined()
  })
})

describe("loadSkills", () => {
  test("loads the shipped slack-search skill from the package", async () => {
    const skills = await loadSkills()
    expect(skills.map((skill) => skill.id)).toEqual(["slack-search"] as never)
    expect(skills[0]?.path).toBe(join(REPO, "skills", "slack-search", "SKILL.md") as never)
    expect(skills[0]?.description).not.toBe("")
    expect(skills[0]?.content).toContain("slack_search_public")
  })

  test("a CRLF copy of the shipped skill loads the same", async () => {
    const [lf] = await loadSkills(folder({ "slack-search": SEARCH }))
    const [fromCrlf] = await loadSkills(folder({ "slack-search": crlf(SEARCH) }))
    expect(fromCrlf?.description).toBe(lf!.description)
    expect(fromCrlf?.content.replace(/\r\n/g, "\n")).toBe(lf!.content)
  })

  test("a missing skill means a broken install", async () => {
    await expect(loadSkills(folder({}))).rejects.toThrow("SKILLS_INVALID: Bundled skill slack-search is missing. Next step: Reinstall the plugin.")
  })

  test("bad frontmatter names the skill and the fix", async () => {
    await expect(loadSkills(folder({ "slack-search": "# no frontmatter\n" }))).rejects.toThrow(
      "SKILLS_INVALID: Bundled skill slack-search has invalid frontmatter. Next step: Reinstall the plugin.",
    )
  })
})
