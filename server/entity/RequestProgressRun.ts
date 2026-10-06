import { MediaRequest } from '@server/entity/MediaRequest';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** The final progress run of a request, for its pop-up once it left the tracker. */
@Entity()
export class RequestProgressRun {
  constructor(init?: Partial<RequestProgressRun>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @OneToOne(() => MediaRequest, { onDelete: 'CASCADE' })
  @JoinColumn()
  public request: MediaRequest;

  @Column({ default: false })
  public is4k: boolean;

  @DbAwareColumn({ type: 'datetime' })
  public finishedAt: Date;

  /** JSON of the RequestProgress the pop-up renders. */
  @Column({ type: 'text' })
  public snapshot: string;
}
