import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRequestFailureRetry1791217547115 implements MigrationInterface {
  name = 'AddRequestFailureRetry1791217547115';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "failureReason" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "failureKind" character varying`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "retryCount" integer NOT NULL DEFAULT '0'`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" ADD "nextRetryAt" TIMESTAMP WITH TIME ZONE`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "nextRetryAt"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "retryCount"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "failureKind"`
    );
    await queryRunner.query(
      `ALTER TABLE "media_request" DROP COLUMN "failureReason"`
    );
  }
}
