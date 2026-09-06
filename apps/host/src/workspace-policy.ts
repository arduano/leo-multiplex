import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Static personal-host policy. The operator selects paths; the OS grants access. */
export class UnrestrictedWorkspacePolicy {
  async roots(): Promise<readonly string[]> { return []; }

  async validate(path: string): Promise<string> {
    const canonical = await this.validatePath(path, "working directory");
    if (!(await stat(canonical)).isDirectory()) throw new Error("The working directory must be an existing directory");
    return canonical;
  }

  async validatePath(path: string, description = "path"): Promise<string> {
    if (!isAbsolute(path)) throw new Error(`The ${description} must be absolute`);
    return realpath(path);
  }
}
