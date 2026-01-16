import { Controller, Post, Body, UseGuards, Get, Patch, Delete, Param, ParseIntPipe, NotFoundException, BadRequestException, Req, Query } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserService } from './user.service';
import { Roles } from '../auth/guards/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

@Controller('users')
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('admin')
export class UserController {
  constructor(private userService: UserService) { }

  @Get()
  findAll(
    @Query('page') page: string,
    @Query('limit') limit: string,
    @Query('search') search: string,
  ) {
    const pageNumber = parseInt(page, 10) || 1;
    const limitNumber = parseInt(limit, 10) || 10;
    return this.userService.findAll(pageNumber, limitNumber, search);
  }

  @Post('register')
  register(@Body() createUserDto: CreateUserDto) {
    return this.userService.createUser(
      createUserDto.email,
      createUserDto.password,
      createUserDto.role,
      createUserDto.firstName,
      createUserDto.lastName,
    );
  }

  @Get('deactivated')
  findDeactivated() {
    return this.userService.findAllDeactivated();
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() updateUserDto: UpdateUserDto) {
    return this.userService.update(id, updateUserDto);
  }

  // Este endpoint ahora hace un "soft delete"
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Req() req) {
    // Lógica de seguridad para evitar que un admin se desactive a sí mismo
    if (req.user.userId === id) {
      throw new BadRequestException('No puedes desactivarte a ti mismo.');
    }
    return this.userService.remove(id);
  }

  // NUEVO ENDPOINT PARA REACTIVAR
  @Post(':id/restore')
  restore(@Param('id', ParseIntPipe) id: number) {
    return this.userService.restore(id);
  }
  @Get('list/agents')
  listAgents() {
    return this.userService.findAllAgents();
  }
}