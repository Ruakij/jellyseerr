import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepSample1791209969951 implements MigrationInterface {
  name = 'AddStepSample1791209969951';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "step_sample" ("id" SERIAL NOT NULL, "serverKey" character varying NOT NULL, "step" character varying NOT NULL, "durationMs" bigint NOT NULL, "finishedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "downloadId" character varying, CONSTRAINT "PK_708e0b6ae908b913753ceb980a2" PRIMARY KEY ("id"))`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_step_sample_server_step" ON "step_sample" ("serverKey", "step") `
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_step_sample_server_step"`
    );
    await queryRunner.query(`DROP TABLE "step_sample"`);
  }
}
