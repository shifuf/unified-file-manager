import { Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestUser } from '../common/types/request-user.type';
import { ListTasksDto } from './dto/list-tasks.dto';
import { TasksService } from './tasks.service';

@ApiTags('任务中心')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  list(
    @Query() query: ListTasksDto,
    @CurrentUser() user: RequestUser,
  ): ReturnType<TasksService['list']> {
    return this.tasksService.list(query, user);
  }

  @Get(':taskId')
  get(
    @Param('taskId') taskId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<TasksService['get']> {
    return this.tasksService.get(taskId, user);
  }

  @Post(':taskId/cancel')
  cancel(
    @Param('taskId') taskId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<TasksService['cancel']> {
    return this.tasksService.cancel(taskId, user);
  }

  @Post(':taskId/retry')
  retry(
    @Param('taskId') taskId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<TasksService['retry']> {
    return this.tasksService.retry(taskId, user);
  }

  @Delete(':taskId')
  remove(
    @Param('taskId') taskId: string,
    @CurrentUser() user: RequestUser,
  ): ReturnType<TasksService['remove']> {
    return this.tasksService.remove(taskId, user);
  }
}
