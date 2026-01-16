// src/chat/entities/chat.entity.ts - VERSIÓN MEJORADA FASE 2

import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { UserWha } from '../../user/user.entity';
import { Message } from './message.entity';
import { ChatStatus } from '../../common/enums/chat-status.enum';
import { SurveyResponse } from './survey-response.entity';
import { InternalNote } from './internal-note.entity';

@Entity()
export class Chat {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  contactNumber: string;

  @Column({ nullable: true })
  customerName: string;

  @Column({
    type: 'enum',
    enum: ChatStatus,
    default: ChatStatus.AUTO_RESPONDER,
  })
  status: ChatStatus;

  // ✅ NUEVO: Columna para contador de mensajes no leídos
  @Column({ type: 'int', default: 0 })
  unreadCount: number;

  @ManyToOne(() => UserWha, (user) => user.chats, { nullable: true })
  assignedTo: UserWha;

  @OneToMany(() => Message, (m) => m.chat)
  messages: Message[];

  @OneToMany(() => SurveyResponse, (response) => response.chat)
  surveyResponses: SurveyResponse[];

  @OneToMany(() => InternalNote, (note) => note.chat)
  notes: InternalNote[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}