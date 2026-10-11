import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepSampleCounts1791723489217 implements MigrationInterface {
  name = 'AddStepSampleCounts1791723489217';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_step_sample_server_step"`);
    await queryRunner.query(
      `CREATE TABLE "temporary_step_sample" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKey" varchar NOT NULL, "step" varchar NOT NULL, "durationMs" bigint NOT NULL, "finishedAt" datetime NOT NULL, "downloadId" varchar, "unitCount" integer, "downloadCount" integer)`
    );
    await queryRunner.query(
      `INSERT INTO "temporary_step_sample"("id", "serverKey", "step", "durationMs", "finishedAt", "downloadId") SELECT "id", "serverKey", "step", "durationMs", "finishedAt", "downloadId" FROM "step_sample"`
    );
    await queryRunner.query(`DROP TABLE "step_sample"`);
    await queryRunner.query(
      `ALTER TABLE "temporary_step_sample" RENAME TO "step_sample"`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_step_sample_server_step" ON "step_sample" ("serverKey", "step") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_step_sample_server_step"`);
    await queryRunner.query(
      `ALTER TABLE "step_sample" RENAME TO "temporary_step_sample"`
    );
    await queryRunner.query(
      `CREATE TABLE "step_sample" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKey" varchar NOT NULL, "step" varchar NOT NULL, "durationMs" bigint NOT NULL, "finishedAt" datetime NOT NULL, "downloadId" varchar)`
    );
    await queryRunner.query(
      `INSERT INTO "step_sample"("id", "serverKey", "step", "durationMs", "finishedAt", "downloadId") SELECT "id", "serverKey", "step", "durationMs", "finishedAt", "downloadId" FROM "temporary_step_sample"`
    );
    await queryRunner.query(`DROP TABLE "temporary_step_sample"`);
    await queryRunner.query(
      `CREATE INDEX "IDX_step_sample_server_step" ON "step_sample" ("serverKey", "step") `
    );
  }
}
