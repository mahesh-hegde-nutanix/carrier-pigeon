import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { SkillSummary } from '../shared/skills';

const SKILLS_DIR = path.join(os.homedir(), '.pigeon', 'skills');
const SKILL_FILE_NAME = 'SKILL.md';
const REFERENCES_DIR_NAME = 'references';

interface SkillFrontmatter {
    name?: unknown;
    description?: unknown;
    'disable-model-invocation'?: unknown;
}

interface Skill {
    summary: SkillSummary;
    directory: vscode.Uri;
    content: string;
}

/** Discovers skills and provides their model-facing content without exposing storage paths. */
export class SkillRegistry {
    private constructor(private readonly skills: Map<string, Skill>) { }

    static async load(): Promise<SkillRegistry> {
        let discovered: vscode.Uri[];
        try {
            discovered = await discoverSkillFiles(vscode.Uri.file(SKILLS_DIR));
        } catch (e) {
            console.error('[Skills] Failed to scan skills directory', e);
            return new SkillRegistry(new Map());
        }
        const skills = new Map<string, Skill>();

        for (const uri of discovered) {
            try {
                const content = await readFileText(uri);
                const summary = parseSkillSummary(content);
                if (skills.has(summary.name)) {
                    console.warn(`[Skills] Ignoring duplicate skill name: ${summary.name}`);
                    continue;
                }
                skills.set(summary.name, {
                    summary,
                    directory: vscode.Uri.file(path.dirname(uri.fsPath)),
                    content
                });
            } catch (e) {
                console.error(`[Skills] Ignoring invalid skill file: ${uri.fsPath}`, e);
            }
        }

        return new SkillRegistry(skills);
    }

    summaries(): SkillSummary[] {
        return [...this.skills.values()]
            .map(skill => skill.summary)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    implicitSummaries(): SkillSummary[] {
        return this.summaries().filter(skill => !skill.disableModelInvocation);
    }

    /** Returns a skill's main page and either its reference tree or selected references. */
    async read(name: string, references: string[] = []): Promise<string> {
        const skill = this.skills.get(name);
        if (!skill) return `(unknown skill: ${name})`;

        const blocks = [skillBlock(skill)];
        if (references.length === 0) {
            try {
                const tree = await referenceTree(skill);
                if (tree) blocks.push(referenceTreeBlock(name, tree));
            } catch (e) {
                console.error(`[Skills] Failed to list references for: ${name}`, e);
                blocks.push(`(references unavailable for skill: ${name})`);
            }
            return blocks.join('\n');
        }

        for (const reference of references) {
            try {
                const content = await readReference(skill, reference);
                blocks.push(referenceBlock(name, reference, content));
            } catch (e) {
                console.error(`[Skills] Failed to read reference '${reference}' for: ${name}`, e);
                blocks.push(`(unknown or unreadable reference '${reference}' for skill '${name}')`);
            }
        }
        return blocks.join('\n');
    }

    /** Renders every skill explicitly invoked by a slash command in text. */
    async contextForInvocations(text: string): Promise<string> {
        const invoked = new Set(
            [...text.matchAll(/(?:^|\s)\/([^\s]+)/g)].map(match => match[1])
        );
        const blocks: string[] = [];
        for (const summary of this.summaries()) {
            if (!invoked.has(summary.name)) continue;
            const skill = this.skills.get(summary.name);
            if (!skill) continue;
            blocks.push(skillBlock(skill));
            try {
                const tree = await referenceTree(skill);
                if (tree) blocks.push(referenceTreeBlock(summary.name, tree));
            } catch (e) {
                console.error(`[Skills] Failed to list references for: ${summary.name}`, e);
            }
        }
        return blocks.join('\n');
    }
}

async function discoverSkillFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(root);
    } catch (e) {
        if (isMissingFileError(e)) return [];
        throw e;
    }

    const files: vscode.Uri[] = [];
    for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
        const uri = vscode.Uri.joinPath(root, name);
        if (type === vscode.FileType.Directory) {
            try {
                files.push(...await discoverSkillFiles(uri));
            } catch (e) {
                console.error(`[Skills] Failed to scan directory: ${uri.fsPath}`, e);
            }
        } else if (type === vscode.FileType.File && name === SKILL_FILE_NAME) {
            files.push(uri);
        }
    }
    return files;
}

function parseSkillSummary(content: string): SkillSummary {
    const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error('missing YAML frontmatter');

    const frontmatter = parseYaml(match[1]) as SkillFrontmatter | null;
    if (!frontmatter || typeof frontmatter !== 'object') {
        throw new Error('frontmatter must be a mapping');
    }
    if (typeof frontmatter.name !== 'string' || !frontmatter.name.trim()) {
        throw new Error('frontmatter name must be a non-empty string');
    }
    const name = frontmatter.name.trim();
    if (/\s/.test(name)) {
        throw new Error('frontmatter name cannot contain whitespace');
    }
    if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
        throw new Error('frontmatter description must be a non-empty string');
    }

    const explicit = frontmatter['disable-model-invocation'];
    if (explicit !== undefined && typeof explicit !== 'boolean') {
        throw new Error('disable-model-invocation must be a boolean');
    }
    return {
        name,
        description: frontmatter.description.trim().replace(/\s+/g, ' '),
        disableModelInvocation: explicit ?? false
    };
}

async function referenceTree(skill: Skill): Promise<string> {
    const root = vscode.Uri.joinPath(skill.directory, REFERENCES_DIR_NAME);
    try {
        return await renderTree(root);
    } catch (e) {
        if (isMissingFileError(e)) return '';
        throw e;
    }
}

async function renderTree(directory: vscode.Uri, prefix = ''): Promise<string> {
    const entries = (await vscode.workspace.fs.readDirectory(directory))
        .sort(([a], [b]) => a.localeCompare(b));
    const lines: string[] = [];
    for (let i = 0; i < entries.length; i++) {
        const [name, type] = entries[i];
        const last = i === entries.length - 1;
        lines.push(`${prefix}${last ? '└── ' : '├── '}${name}`);
        if (type === vscode.FileType.Directory) {
            const childPrefix = prefix + (last ? '    ' : '│   ');
            const children = await renderTree(vscode.Uri.joinPath(directory, name), childPrefix);
            if (children) lines.push(children);
        }
    }
    return lines.join('\n');
}

async function readReference(skill: Skill, reference: string): Promise<string> {
    const normalized = path.posix.normalize(reference.replace(/\\/g, '/'));
    if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) ||
        normalized === '..' || normalized.startsWith('../')) {
        throw new Error('reference must be a relative file path');
    }

    const referencesRoot = vscode.Uri.joinPath(skill.directory, REFERENCES_DIR_NAME);
    const target = vscode.Uri.joinPath(referencesRoot, ...normalized.split('/'));
    const [realRoot, realTarget] = await Promise.all([
        fs.realpath(referencesRoot.fsPath),
        fs.realpath(target.fsPath)
    ]);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new Error('reference resolves outside the references directory');
    }
    const stat = await vscode.workspace.fs.stat(target);
    if (stat.type !== vscode.FileType.File) throw new Error('reference is not a file');
    return readFileText(target);
}

function skillBlock(skill: Skill): string {
    return [
        `------------------- begins: ${skill.summary.name} ---------------------`,
        skill.content,
        `------------------- ends: ${skill.summary.name} -----------------`
    ].join('\n');
}

function referenceBlock(skillName: string, reference: string, content: string): string {
    return [
        `------------------- begins: ${skillName} reference ${reference} ---------------------`,
        content,
        `------------------- ends: ${skillName} reference ${reference} -----------------`
    ].join('\n');
}

function referenceTreeBlock(skillName: string, tree: string): string {
    return [
        '----',
        `REFERENCES FOR ${skillName} (use read_skill tool to drill down)`,
        tree,
        '----'
    ].join('\n');
}

function isMissingFileError(error: unknown): boolean {
    return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

async function readFileText(uri: vscode.Uri): Promise<string> {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
}
