/**
 * LuaLune Terms of Service.
 * Bumping `version` forces every account to re-accept on their next sign-in.
 */

export const TOS_VERSION = "2026-09-25";

export const TOS = {
  version: TOS_VERSION,
  updated: "25 September 2026",
  contact: "support@lualune.onrender.com",
  sections: [
    {
      title: "1. The service",
      body: "LuaLune turns Lua and Luau source code into protected builds and gives you a loader URL for each one. You keep ownership of the scripts you upload. We store the protected build, the keys you create and the logs needed to run the service.",
    },
    {
      title: "2. Your account",
      body: "One person per account. Keep your password to yourself; anything done with your credentials counts as you. Accounts that stay unused for a long time may be reclaimed. You can delete a script, a key or your whole account at any time from the dashboard.",
    },
    {
      title: "3. Acceptable use",
      body: "Do not use LuaLune to distribute malware, steal credentials, bypass another developer's protections, cheat in a way that harms other players, or hide anything illegal. Do not resell access to the obfuscator or scrape the service. If we see abuse we can suspend or terminate the account without notice.",
    },
    {
      title: "4. Protection is not a guarantee",
      body: "Obfuscation raises the cost of reading your source. It is not encryption and it cannot make a script impossible to analyse, because an executor still has to run it. Never put secrets, tokens or private keys inside a script you protect with LuaLune.",
    },
    {
      title: "5. Cost",
      body: "LuaLune is free and unlimited: there are no plans, no paid tiers and no billing. Every account can create as many scripts, builds, keys, whitelist entries and shares as it needs, and execution logs are available to everyone. The only limits are technical ones that keep the service usable for everyone — per-minute request throttles and a maximum source size per build.",
    },
    {
      title: "6. Availability",
      body: "The service is provided as-is. We aim to keep loader URLs stable, but we may change or retire endpoints with notice where we can. We are not liable for lost revenue, lost scripts or downtime beyond replacing the service.",
    },
    {
      title: "7. Changes",
      body: "We may update these terms. When the version changes you will be asked to accept the new terms before you can create another build.",
    },
  ],
};

export function tosSummary() {
  return { version: TOS.version, updated: TOS.updated, contact: TOS.contact, sections: TOS.sections };
}
