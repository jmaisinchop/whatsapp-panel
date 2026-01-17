// user.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like, Not, IsNull } from 'typeorm';
import { UserWha } from './user.entity';
import * as bcrypt from 'bcrypt';
import { ChatStatus } from '../common/enums/chat-status.enum';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserWha)
    private readonly userRepo: Repository<UserWha>,
  ) { }

  async findAll(page = 1, limit = 10, search = '') {
    const skip = (page - 1) * limit;

    const [users, total] = await this.userRepo.findAndCount({
      withDeleted: true,
      select: ['id', 'email', 'firstName', 'lastName', 'role', 'deletedAt', 'createdAt'],
      where: [
        { firstName: Like(`%${search}%`) },
        { lastName: Like(`%${search}%`) },
        { email: Like(`%${search}%`) },
      ],
      skip: skip,
      take: limit,
      order: {
        id: 'DESC',
      },
    });

    return {
      data: users,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findByEmail(email: string) {
    return this.userRepo.findOne({ where: { email } });
  }

  async findById(id: number) {
    return this.userRepo.findOne({ where: { id } });
  }

  async createUser(email: string, password: string, role: string, firstName?: string, lastName?: string) {
    const hashed = await bcrypt.hash(password, 10);
    const user = this.userRepo.create({ email, password: hashed, role, firstName, lastName });
    return this.userRepo.save(user);
  }

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.userRepo.findOneBy({ id });
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (updateUserDto.password) {
      updateUserDto.password = await bcrypt.hash(updateUserDto.password, 10);
    }
    Object.assign(user, updateUserDto);
    return this.userRepo.save(user);
  }

  async remove(id: number) {
    const result = await this.userRepo.softDelete({ id });
    if (result.affected === 0) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return { message: 'Usuario desactivado para auditoría.' };
  }

  async restore(id: number) {
    const result = await this.userRepo.restore({ id });
    if (result.affected === 0) {
      throw new NotFoundException('Usuario no encontrado o ya está activo');
    }
    return { message: 'Usuario reactivado exitosamente.' };
  }

  async validatePassword(plain: string, hashed: string) {
    return bcrypt.compare(plain, hashed);
  }

  async findAgentWithFewerChats(connectedAgentIds: number[], excludeAgentId?: number): Promise<UserWha | null> {
    if (connectedAgentIds.length === 0) {
      return null;
    }

    const qb = this.userRepo
      .createQueryBuilder('u')
      .leftJoin('u.chats', 'chat', 'chat.status = :status', {
        status: ChatStatus.ACTIVE,
      })
      .where('u.role = :role', { role: 'agent' })
      .andWhere('u.id IN (:...connectedAgentIds)', { connectedAgentIds })
      .groupBy('u.id')
      .orderBy('COUNT(chat.id)', 'ASC')
      .limit(1);

    if (excludeAgentId) {
      qb.andWhere('u.id != :excludeAgentId', { excludeAgentId });
    }
    return await qb.getOne();
  }

  async findAllDeactivated() {
    return this.userRepo.find({
      withDeleted: true,
      where: {
        deletedAt: Not(IsNull()),
      },
      select: ['id', 'email', 'firstName', 'lastName', 'role', 'deletedAt'],
      order: {
        deletedAt: 'DESC'
      }
    });
  }

  async findAllAgents() {
    return this.userRepo.find({
      where: { role: 'agent' },
      select: ['id', 'firstName', 'lastName'],
    });
  }
}