import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { z } from 'zod'

const sessionSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().min(1).max(200),
  firstPeriodName: z.string().min(1).max(100),
  budget: z.number().int().positive()
})

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions)

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(request.url)
    const categoryId = searchParams.get('categoryId')

    // 作業中（draft）のセッションは作成者のみ、公開済み（confirmed/archived）は全員が見れる
    const where: any = categoryId ? { categoryId } : {}

    where.OR = [
      { status: { in: ['confirmed', 'archived'] } }, // 公開済みは全員
      {
        status: 'draft',
        category: { userId: session.user.id } // 作業中は作成者のみ
      }
    ]

    const sessions = await prisma.session.findMany({
      where,
      include: {
        category: {
          include: {
            user: {
              select: { name: true, email: true }
            }
          }
        },
        periodBudgets: {
          orderBy: { period: 'asc' }
        }
      },
      orderBy: { createdAt: 'desc' }
    })

    return NextResponse.json(
      sessions.map(s => ({
        ...s,
        periodBudgets: s.periodBudgets.map(pb => ({
          ...pb,
          budget: pb.budget.toString()
        }))
      }))
    )
  } catch (error) {
    console.error('Error fetching sessions:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const authSession = await getServerSession(authOptions)

    if (!authSession?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const { categoryId, name, firstPeriodName, budget } = sessionSchema.parse(body)

    // Verify category exists
    const category = await prisma.category.findUnique({
      where: { id: categoryId }
    })

    if (!category) {
      return NextResponse.json(
        { error: 'Category not found' },
        { status: 404 }
      )
    }

    // Create session with first period budget
    const newSession = await prisma.session.create({
      data: {
        categoryId,
        name,
        status: 'draft',
        periodBudgets: {
          create: {
            period: firstPeriodName.trim(),
            budget: BigInt(budget)
          }
        }
      },
      include: {
        category: true,
        periodBudgets: true
      }
    })

    return NextResponse.json(
      {
        ...newSession,
        periodBudgets: newSession.periodBudgets.map(pb => ({
          ...pb,
          budget: pb.budget.toString()
        }))
      },
      { status: 201 }
    )
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input', details: error.errors },
        { status: 400 }
      )
    }

    console.error('Error creating session:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
