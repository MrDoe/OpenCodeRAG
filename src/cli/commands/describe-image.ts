/**
 * @fileoverview Describe-image command for generating image descriptions via a configured vision model provider.
 */
/**
 * `describe-image` command — describes an image file using a configured vision model.
 */

import type { Command } from "commander";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { c, resolveCliContext, cleanupContext, logCliError, logCliInfo } from "../format.js";
import type { CliOptions } from "../types.js";

/**
 * Register the `describe-image` command on the given Commander program.
 *
 * Loads an image file, resizes it if necessary, encodes it as base64,
 * and sends it to the configured vision provider (Ollama, OpenAI, etc.)
 * for a natural-language description.
 *
 * @param program - The Commander `Command` instance to register on.
 */
export function registerDescribeImageCommand(program: Command): void {
  program
    .command("describe-image")
    .description("Describe an image file using a vision model")
    .argument("<filePath>", "path to image file")
    .option("-c, --config <path>", "path to config file")
    .option("-s, --system-prompt <text>", "optional system prompt to steer the description toward specific features")
    .action(async (filePath: string, options: CliOptions) => {
      try {
        const cwd = process.cwd();
        let logFilePath = path.resolve(cwd, ".opencode", "opencode-rag.log");
        const ctx = await resolveCliContext(options, logFilePath);
        const { config } = ctx;
        logFilePath = ctx.logFilePath;

        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);

        if (!existsSync(resolvedPath)) {
          logCliError(logFilePath, "describe-image", `\nFile not found: ${filePath}`, undefined);
          process.exit(1);
        }

        const ext = path.extname(resolvedPath).toLowerCase();
        const { SUPPORTED_IMAGE_EXTENSIONS, createImageVisionProvider, getMimeType } = await import("../../chunker/image.js");

        if (!SUPPORTED_IMAGE_EXTENSIONS.has(ext)) {
          const exts = [...SUPPORTED_IMAGE_EXTENSIONS].join(", ");
          logCliError(logFilePath, "describe-image", `\nUnsupported file extension "${ext}". Supported: ${exts}`, undefined);
          process.exit(1);
        }

        const imageDescriptionConfig = config.imageDescription;
        if (!imageDescriptionConfig?.enabled) {
          logCliError(logFilePath, "describe-image", `\nImage description is not enabled in config. Set imageDescription.enabled to true.`, undefined);
          process.exit(1);
        }

        const { resizeImage } = await import("../../content/image.js");

        logCliInfo(logFilePath, "describe-image", `\n${c.heading("Describing image:")} ${c.file(filePath)}`);
        logCliInfo(logFilePath, "describe-image", `  ${c.label("Provider:")} ${c.value(imageDescriptionConfig.provider)}`);
        logCliInfo(logFilePath, "describe-image", `  ${c.label("Model:")}    ${c.value(imageDescriptionConfig.model)}`);

        const buffer = readFileSync(resolvedPath);
        const mimeType = getMimeType(ext);
        const maxDimension = imageDescriptionConfig.resizeMaxDimension ?? 1024;
        const sized = maxDimension > 0 ? await resizeImage(buffer, resolvedPath, maxDimension) : buffer;
        const b64 = sized.toString("base64");

        const provider = createImageVisionProvider(imageDescriptionConfig);
        const description = await provider.describeImage(b64, mimeType, imageDescriptionConfig.prompt, options.systemPrompt);

        logCliInfo(logFilePath, "describe-image", `\n${c.desc(description)}\n`);
        await cleanupContext(ctx);
      } catch (err) {
        const message = (err as Error).message || String(err);
        const logFilePath = path.resolve(process.cwd(), ".opencode", "opencode-rag.log");
        logCliError(logFilePath, "describe-image", `\nDescribe image failed: ${message}`, err);
        process.exit(1);
      }
    });
}
