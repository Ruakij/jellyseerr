import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepSample1791209948046 implements MigrationInterface {
  name = 'AddStepSample1791209948046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "step_sample" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "serverKey" varchar NOT NULL, "step" varchar NOT NULL, "durationMs" bigint NOT NULL, "finishedAt" datetime NOT NULL, "downloadId" varchar)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_step_sample_server_step" ON "step_sample" ("serverKey", "step") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_step_sample_server_step"`);
    await queryRunner.query(`DROP TABLE "step_sample"`);
  }
}
