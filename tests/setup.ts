import { faker } from "@faker-js/faker";

// Seed faker with the run-level seed set by global-setup.ts.
// Falls back to a random value if running outside the normal test runner.
const seed = process.env.TEST_SEED
  ? parseInt(process.env.TEST_SEED, 10)
  : Math.floor(Math.random() * 0xffff_ffff);

faker.seed(seed);
