import { stat } from "node:fs/promises"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

const DEFAULT_MAX_CHARS = 40000

function buildPdfPath(inputPath: string, directory: string): string {
  if (path.isAbsolute(inputPath)) {
    return path.normalize(inputPath)
  }

  return path.resolve(directory, inputPath)
}

function validatePages(firstPage?: number, lastPage?: number): void {
  if (firstPage !== undefined && firstPage < 1) {
    throw new Error("firstPage must be >= 1")
  }

  if (lastPage !== undefined && lastPage < 1) {
    throw new Error("lastPage must be >= 1")
  }

  if (firstPage !== undefined && lastPage !== undefined && firstPage > lastPage) {
    throw new Error("firstPage must be <= lastPage")
  }
}

export default tool({
  description: "Extract text from a PDF file with pdftotext",
  args: {
    filePath: tool.schema.string().describe("Path to the PDF file (absolute or relative to current directory)."),
    firstPage: tool.schema.number().int().optional().describe("First page to extract (1-based)."),
    lastPage: tool.schema.number().int().optional().describe("Last page to extract (1-based)."),
    preserveLayout: tool.schema.boolean().optional().describe("Keep original physical layout using pdftotext -layout."),
    rawOrder: tool.schema.boolean().optional().describe("Keep content stream order using pdftotext -raw."),
    maxChars: tool.schema.number().int().positive().optional().describe("Maximum characters returned (default 40000)."),
  },
  async execute(args, context) {
    validatePages(args.firstPage, args.lastPage)

    const resolvedPath = buildPdfPath(args.filePath, context.directory)
    const fileStats = await stat(resolvedPath).catch(() => null)
    if (!fileStats || !fileStats.isFile()) {
      throw new Error(`PDF not found: ${resolvedPath}`)
    }

    if (path.extname(resolvedPath).toLowerCase() !== ".pdf") {
      throw new Error(`Not a PDF file: ${resolvedPath}`)
    }

    const cmd = ["pdftotext"]

    if (args.preserveLayout) {
      cmd.push("-layout")
    }

    if (args.rawOrder) {
      cmd.push("-raw")
    }

    if (args.firstPage !== undefined) {
      cmd.push("-f", String(args.firstPage))
    }

    if (args.lastPage !== undefined) {
      cmd.push("-l", String(args.lastPage))
    }

    cmd.push(resolvedPath, "-")

    const proc = Bun.spawn({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (exitCode !== 0) {
      const reason = stderr.trim() || "unknown pdftotext error"
      throw new Error(`pdftotext failed (${exitCode}): ${reason}`)
    }

    const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS
    const text = stdout.replace(/\r\n/g, "\n")
    if (text.length <= maxChars) {
      return text
    }

    const truncated = text.slice(0, maxChars)
    const omitted = text.length - maxChars

    return `${truncated}\n\n[truncated ${omitted} chars; increase maxChars to return more]`
  },
})
