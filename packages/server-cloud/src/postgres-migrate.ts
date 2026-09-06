import { PostgresCloudRepository } from "./postgres-repository.js";

const databaseUrl = process.env.DAOYIN_CLOUD_POSTGRES_URL ?? "";
try {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("unsupported protocol");
} catch {
  throw new Error("Set DAOYIN_CLOUD_POSTGRES_URL to a PostgreSQL connection URL before migrating.");
}

const repository = await PostgresCloudRepository.open(databaseUrl);
try {
  await repository.migrate();
  process.stdout.write("PostgreSQL cloud schema is ready.\n");
} finally {
  await repository.close();
}
