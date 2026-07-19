import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".marker-test-dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // Disable experimental React Compiler rules that produce false positives
    // for valid React patterns (ref sync in render, setState in useEffect, etc.).
    // These are part of eslint-plugin-react-compiler bundled with Next.js 16
    // and are not yet stable.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);

export default eslintConfig;
