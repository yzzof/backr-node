#!/usr/bin/env node

import { program } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn, execFileSync } from "child_process";
import { Client, SFTPWrapper } from "ssh2";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Config {
  ssh_host: string;
  ssh_port?: number;
  ssh_user: string;
  ssh_private_key_path?: string;
  ssh_password?: string;
  target: string;
  compression?: string;
  include: string[];
  exclude: string[];
}

interface CliOpts {
  localTarget?: boolean;
  compression?: string;
  target?: string;
  include?: string[];
  exclude?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve `~` to the home directory */
function resolvePath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  if (p === "~") {
    return os.homedir();
  }
  return p;
}

/** Check if a program exists on PATH */
function isInstalled(prog: string): boolean {
  const ext = process.platform === "win32" ? ".exe" : "";
  const dirs = (process.env.PATH || "").split(path.delimiter);
  return dirs.some((dir) => {
    try {
      const full = path.join(dir, prog + ext);
      return fs.statSync(full).isFile();
    } catch {
      return false;
    }
  });
}

/** Detect a supported package manager and install a package */
function tryInstall(pkg: string): void {
  const managers: { bin: string; args: string[]; sudo: boolean }[] = [
    { bin: "apt-get", args: ["install", "-y"], sudo: true },
    { bin: "dnf", args: ["install", "-y"], sudo: true },
    { bin: "pacman", args: ["-S", "--noconfirm"], sudo: true },
    { bin: "brew", args: ["install"], sudo: false },
  ];

  const mgr = managers.find((m) => isInstalled(m.bin));
  if (!mgr) {
    throw new Error(
      "No supported package manager found (tried apt-get, dnf, pacman, brew)"
    );
  }

  const cmd = mgr.sudo ? "sudo" : mgr.bin;
  const cmdArgs = mgr.sudo
    ? [mgr.bin, ...mgr.args, pkg]
    : [...mgr.args, pkg];

  try {
    execFileSync(cmd, cmdArgs, { stdio: "inherit" });
  } catch {
    throw new Error(`Installation of '${pkg}' failed`);
  }
}

/** Formatted timestamp matching the Rust version: YYYY-MM-DDTHH-MM-SS */
function getTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return [
    d.getUTCFullYear(),
    "-",
    pad(d.getUTCMonth() + 1),
    "-",
    pad(d.getUTCDate()),
    "T",
    pad(d.getUTCHours()),
    "-",
    pad(d.getUTCMinutes()),
    "-",
    pad(d.getUTCSeconds()),
  ].join("");
}

/** Prompt the user with a yes/no question on stderr */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (data: string) => {
      process.stdin.pause();
      resolve(data.trim().toLowerCase() === "y");
    });
  });
}

// ---------------------------------------------------------------------------
// Backup logic
// ---------------------------------------------------------------------------

async function runBackup(config: Config, localTarget: boolean): Promise<void> {
  const hostname = os.hostname().replace(/\s+/g, "_");
  const timestamp = getTimestamp();
  const compression = config.compression || "pixz";

  // Ensure compression program is available
  if (!isInstalled(compression)) {
    const yes = await askYesNo(
      `\u26a0\ufe0f  '${compression}' is not installed. Install it now? [y/N] `
    );
    if (yes) {
      tryInstall(compression);
      if (!isInstalled(compression)) {
        throw new Error(`'${compression}' still not found after installation`);
      }
      process.stderr.write(`\u2705 '${compression}' installed successfully.\n`);
    } else {
      throw new Error(`'${compression}' is required but not installed`);
    }
  }

  // Archive extension
  const ext = compression === "pigz" ? "gz" : "xz";
  const archiveName = `${hostname}_backup_${timestamp}.tar.${ext}`;

  // Validate include paths
  const validPaths: string[] = [];
  for (const p of config.include) {
    const resolved = resolvePath(p);
    if (fs.existsSync(resolved)) {
      validPaths.push(resolved);
    } else {
      process.stderr.write(`\u26a0\ufe0f  Warning: Path not found, skipping: ${p}\n`);
    }
  }

  if (validPaths.length === 0) {
    throw new Error("No valid backup paths found.");
  }

  const outputPath = `${config.target.replace(/\/+$/, "")}/${archiveName}`;

  console.log(`\n\ud83d\udce6 Starting Streamed Backup for host: ${hostname}`);
  console.log(`\ud83d\udd25 Compression: ${compression} (Multi-threaded)`);

  // Build tar arguments
  const isGnuTar = process.platform === "linux";
  const compressFlag = isGnuTar ? "-I" : "--use-compress-program";
  const cpus = Math.max(1, Math.floor(os.cpus().length / 2));
  const compressCmd = `${compression} -p ${cpus}`;

  const tarArgs: string[] = [compressFlag, compressCmd];
  for (const p of config.exclude) {
    tarArgs.push("--exclude", p);
  }
  tarArgs.push("-cvf", "-");
  for (const p of validPaths) {
    tarArgs.push(p);
  }

  if (localTarget) {
    // ---- Local backup ----
    console.log(`\ud83d\udcbe Destination: ${outputPath}`);

    await new Promise<void>((resolve, reject) => {
      const outStream = fs.createWriteStream(outputPath);
      const tar = spawn("tar", tarArgs, {
        stdio: ["ignore", "pipe", "inherit"],
      });

      tar.stdout!.pipe(outStream);

      tar.on("close", (code: number | null) => {
        if (code !== 0) {
          process.stderr.write(
            `\u274c Tar exited with ${code}. Check if '${compression}' is installed.\n`
          );
          return reject(new Error("Tar process failed"));
        }
        resolve();
      });

      tar.on("error", (err: Error) => reject(err));
      outStream.on("error", (err: Error) => reject(err));
    });

    console.log("\u2705 Local backup written successfully.");
  } else {
    // ---- Remote backup via SSH/SFTP ----
    console.log(`\ud83d\udce1 Destination: ${config.ssh_host}:${outputPath}`);

    const sshConfig: Record<string, unknown> = {
      host: config.ssh_host,
      port: config.ssh_port || 22,
      username: config.ssh_user,
    };

    if (config.ssh_private_key_path) {
      const keyPath = resolvePath(config.ssh_private_key_path);
      sshConfig.privateKey = fs.readFileSync(keyPath);
    } else if (config.ssh_password) {
      sshConfig.password = config.ssh_password;
    } else {
      throw new Error("No authentication method provided in config.json");
    }

    await new Promise<void>((resolve, reject) => {
      const conn = new Client();

      conn.on("ready", () => {
        console.log("\u2705 SSH Connection established. Starting stream...");

        conn.sftp((err: Error | undefined, sftp: SFTPWrapper) => {
          if (err) {
            conn.end();
            return reject(
              new Error(`Failed to initialize SFTP session: ${err.message}`)
            );
          }

          const remoteStream = sftp.createWriteStream(outputPath);

          remoteStream.on("error", (streamErr: Error) => {
            conn.end();
            reject(
              new Error(
                `Failed to create remote file at ${outputPath}: ${streamErr.message}`
              )
            );
          });

          const tar = spawn("tar", tarArgs, {
            stdio: ["ignore", "pipe", "inherit"],
          });

          tar.stdout!.pipe(remoteStream);

          tar.on("error", (tarErr: Error) => {
            conn.end();
            reject(tarErr);
          });

          remoteStream.on("close", () => {
            conn.end();
          });

          tar.on("close", (code: number | null) => {
            if (code !== 0) {
              process.stderr.write(
                `\u274c Tar exited with ${code}. Check if '${compression}' is installed.\n`
              );
              conn.end();
              return reject(new Error("Tar process failed"));
            }
            console.log("\u2705 Local compression finished.");
            console.log("\u2705 Upload stream closed successfully.");
            resolve();
          });
        });
      });

      conn.on("error", (connErr: Error) => {
        reject(
          new Error(
            `Failed to connect to ${sshConfig.host}:${sshConfig.port}: ${connErr.message}`
          )
        );
      });

      conn.connect(sshConfig);
    });
  }
}

// ---------------------------------------------------------------------------
// CLI & main
// ---------------------------------------------------------------------------

program
  .name("backr-node")
  .description("Streaming backup tool using tar + SSH/SFTP")
  .option(
    "-l, --local-target",
    "Write backup to a local path instead of uploading via SSH/SFTP"
  )
  .option(
    "-c, --compression <program>",
    "Compression program to use: pixz (xz) or pigz (gzip). Overrides config.json."
  )
  .option(
    "-t, --target <dir>",
    "Target directory for backup storage. Overrides config.json."
  )
  .option(
    "-i, --include <path...>",
    "Path to include in backup; may be specified multiple times. Overrides config.json include."
  )
  .option(
    "-e, --exclude <path...>",
    "Path to exclude from backup; may be specified multiple times. Overrides config.json exclude."
  );

program.parse(process.argv);
const opts = program.opts<CliOpts>();

// Load config.json
const configPath = path.join(process.cwd(), "config.json");
let configContent: string;

if (fs.existsSync(configPath)) {
  try {
    configContent = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    process.stderr.write(
      `\u274c Error loading config.json: ${(err as Error).message}\n`
    );
    process.exit(1);
  }
} else {
  const examplePath = path.join(process.cwd(), "config.example.json");
  const exampleConfig = JSON.stringify(
    {
      ssh_host: "hostname.local",
      ssh_port: 22,
      ssh_user: "username",
      ssh_private_key_path: "~/.ssh/id_ed25519",
      target: "/media/user/backups/",
      compression: "pixz",
      include: ["/"],
      exclude: [
        "/dev/*",
        "/proc/*",
        "/sys/*",
        "/tmp/*",
        "/run/*",
        "/mnt/*",
        "/media/*",
        "/swapfile",
      ],
    },
    null,
    2
  );
  try {
    fs.writeFileSync(examplePath, exampleConfig + "\n");
    process.stderr.write("\u274c config.json not found.\n");
    process.stderr.write(
      `   A template has been written to: ${examplePath}\n`
    );
    process.stderr.write(
      "   Copy it to config.json, fill in your values, and run backr-node again.\n"
    );
  } catch (err) {
    process.stderr.write(
      `\u274c config.json not found and could not write config.example.json: ${(err as Error).message}\n`
    );
  }
  process.exit(1);
}

let config: Config;
try {
  config = JSON.parse(configContent);
} catch (err) {
  process.stderr.write(
    `\u274c Error parsing config.json: ${(err as Error).message}\n`
  );
  process.exit(1);
}

// Apply CLI overrides
if (opts.compression) config.compression = opts.compression;
if (opts.target) config.target = opts.target;
if (opts.include && opts.include.length > 0) config.include = opts.include;
if (opts.exclude && opts.exclude.length > 0) config.exclude = opts.exclude;

// Run
runBackup(config, !!opts.localTarget)
  .then(() => {
    console.log("\n\ud83c\udf89 Backup completed successfully!");
  })
  .catch((err: Error) => {
    process.stderr.write(`\n\ud83d\udca5 Backup failed: ${err.message}\n`);
    process.exit(1);
  });
