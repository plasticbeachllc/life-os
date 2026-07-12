export interface GmailCredentialStore {
  getRefreshToken(accountId: string): string | undefined;
  setRefreshToken(accountId: string, refreshToken: string): void;
}

export class MacOsKeychainGmailCredentialStore implements GmailCredentialStore {
  private readonly service = "life-os.gmail.refresh-token";

  getRefreshToken(accountId: string): string | undefined {
    const result = Bun.spawnSync([
      "/usr/bin/security", "find-generic-password",
      "-s", this.service, "-a", accountId, "-w",
    ], { stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    const value = new TextDecoder().decode(result.stdout).trim();
    return value || undefined;
  }

  setRefreshToken(accountId: string, refreshToken: string): void {
    if (!refreshToken) throw new Error("refusing to store an empty Gmail refresh token");
    const result = Bun.spawnSync([
      "/usr/bin/security", "add-generic-password", "-U",
      "-s", this.service, "-a", accountId, "-w", refreshToken,
    ], { stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) {
      const detail = new TextDecoder().decode(result.stderr).trim();
      throw new Error(`failed to store Gmail refresh token in macOS Keychain${detail ? `: ${detail}` : ""}`);
    }
  }

}
