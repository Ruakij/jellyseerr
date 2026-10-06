import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowUnfinishedRequestProgressRun1791380000000 implements MigrationInterface {
  name = 'AllowUnfinishedRequestProgressRun1791380000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "request_progress_run" ALTER COLUMN "finishedAt" DROP NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "request_progress_run" WHERE "finishedAt" IS NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "request_progress_run" ALTER COLUMN "finishedAt" SET NOT NULL`
    );
  }
}
