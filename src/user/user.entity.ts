// src/user/user.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  DeleteDateColumn,
  CreateDateColumn
} from 'typeorm';
import { Chat } from '../chat/entities/chat.entity';
import { InternalNote } from 'src/chat/entities/internal-note.entity';

@Entity()
export class UserWha {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  email: string;

  @Column({ nullable: true })
  firstName: string;

  @Column({ nullable: true })
  lastName: string;

  @Column()
  password: string;

  @Column({
    type: 'enum',
    enum: ['admin', 'agent', 'user'],
    default: 'user',
  })
  role: string;

  
  @OneToMany(() => InternalNote, (note) => note.author)
  internalNotes: InternalNote[];

  @OneToMany(() => Chat, (chat) => chat.assignedTo)
  chats: Chat[];
  @CreateDateColumn()
  createdAt: Date;
  @DeleteDateColumn()
  deletedAt?: Date;
}
