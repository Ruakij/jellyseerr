import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddStepSampleCounts1791723511634 implements MigrationInterface {
  name = 'AddStepSampleCounts1791723511634';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "step_sample" ADD "unitCount" integer`
    );
    await queryRunner.query(
      `ALTER TABLE "step_sample" ADD "downloadCount" integer`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "step_sample" DROP COLUMN "downloadCount"`
    );
    await queryRunner.query(
      `ALTER TABLE "step_sample" DROP COLUMN "unitCount"`
    );
  }
}
