// src/user/dto/create-user.dto.ts

import { IsEmail, IsString, MinLength, IsEnum, IsOptional } from 'class-validator';



export class CreateUserDto {

    @IsEmail({}, { message: 'El campo email debe ser un correo electrónico válido.' })

    email: string;



    @IsString()

    @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })

    password: string;



    @IsEnum(['admin', 'agent'], { message: 'El rol debe ser "admin" o "agent".' })

    role: string;



    @IsString()

    @IsOptional() // El campo es opcional

    firstName?: string;



    @IsString()

    @IsOptional() // El campo es opcional

    lastName?: string;

}

