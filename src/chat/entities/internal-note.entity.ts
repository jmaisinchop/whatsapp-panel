// src/chat/entities/internal-note.entity.ts

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
} from 'typeorm';
import { Chat } from './chat.entity';
import { UserWha } from '../../user/user.entity';

@Entity()
export class InternalNote {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'text' })
  content: string;

  // Relación para saber qué chat tiene esta nota
  @ManyToOne(() => Chat, (chat) => chat.notes, { onDelete: 'CASCADE' })
  chat: Chat;

  // Relación para saber qué agente escribió la nota
  @ManyToOne(() => UserWha, (user) => user.internalNotes, { eager: true })
  author: UserWha;

  @CreateDateColumn()
  createdAt: Date;
}