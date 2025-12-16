import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

/**
 * PUT /api/sessions/[id]/periods/[period]
 * Rename a period (updates both period budget and allocations)
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; period: string }> }
) {
  try {
    const { id: sessionId, period: oldPeriod } = await params;
    const body = await request.json();
    const { newPeriod, budget } = body;

    // Decode URL-encoded period
    const decodedOldPeriod = decodeURIComponent(oldPeriod);
    const actualOldPeriod = decodedOldPeriod === 'null' ? null : decodedOldPeriod;

    // Validate new period name
    if (!newPeriod || typeof newPeriod !== 'string' || newPeriod.trim() === '') {
      return NextResponse.json(
        { error: 'New period name is required' },
        { status: 400 }
      );
    }

    // Validate budget if provided
    if (budget !== undefined && (typeof budget !== 'number' || budget <= 0)) {
      return NextResponse.json(
        { error: 'Budget must be a positive number' },
        { status: 400 }
      );
    }

    // Verify session exists
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Check if old period budget exists
    const oldPeriodBudget = await prisma.periodBudget.findUnique({
      where: {
        sessionId_period: {
          sessionId,
          period: actualOldPeriod as string,
        },
      },
    });

    if (!oldPeriodBudget) {
      return NextResponse.json(
        { error: 'Period not found' },
        { status: 404 }
      );
    }

    // Check if period name is actually changing
    const isPeriodNameChanging = actualOldPeriod !== newPeriod.trim();

    // If period name is changing, check if new name already exists
    if (isPeriodNameChanging) {
      const existingPeriodBudget = await prisma.periodBudget.findUnique({
        where: {
          sessionId_period: {
            sessionId,
            period: newPeriod.trim(),
          },
        },
      });

      if (existingPeriodBudget) {
        return NextResponse.json(
          { error: 'New period name already exists' },
          { status: 409 }
        );
      }
    }

    // Use transaction to update period budget and allocations
    const result = await prisma.$transaction(async (tx) => {
      if (isPeriodNameChanging) {
        // Period name is changing: delete old and create new
        await tx.periodBudget.delete({
          where: {
            sessionId_period: {
              sessionId,
              period: actualOldPeriod as string,
            },
          },
        });

        await tx.periodBudget.create({
          data: {
            sessionId,
            period: newPeriod.trim(),
            budget: budget !== undefined ? BigInt(budget) : oldPeriodBudget.budget,
          },
        });

        // Update all allocations with the new period name
        const allocationsResult = await tx.allocation.updateMany({
          where: {
            sessionId,
            period: actualOldPeriod as string | null,
          },
          data: {
            period: newPeriod.trim(),
          },
        });

        return { updated: allocationsResult.count };
      } else {
        // Period name not changing: just update budget
        await tx.periodBudget.update({
          where: {
            sessionId_period: {
              sessionId,
              period: actualOldPeriod as string,
            },
          },
          data: {
            budget: budget !== undefined ? BigInt(budget) : oldPeriodBudget.budget,
          },
        });

        return { updated: 0 };
      }
    });

    return NextResponse.json({
      success: true,
      oldPeriod: actualOldPeriod,
      newPeriod: newPeriod.trim(),
      updated: result.updated,
    });
  } catch (error) {
    console.error('Error renaming period:', error);
    console.error('Error details:', error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/sessions/[id]/periods/[period]
 * Delete a period (period budget and allocations - CASCADE)
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; period: string }> }
) {
  try {
    const { id: sessionId, period } = await params;

    // Decode URL-encoded period
    const decodedPeriod = decodeURIComponent(period);
    const actualPeriod = decodedPeriod === 'null' ? null : decodedPeriod;

    // Verify session exists
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // Check if period budget exists
    const periodBudget = await prisma.periodBudget.findUnique({
      where: {
        sessionId_period: {
          sessionId,
          period: actualPeriod as string,
        },
      },
    });

    if (!periodBudget) {
      return NextResponse.json(
        { error: 'Period not found' },
        { status: 404 }
      );
    }

    // Delete period budget (allocations will be CASCADE deleted)
    await prisma.periodBudget.delete({
      where: {
        sessionId_period: {
          sessionId,
          period: actualPeriod as string,
        },
      },
    });

    // Also explicitly delete allocations to get count
    const result = await prisma.allocation.deleteMany({
      where: {
        sessionId,
        period: actualPeriod as string | null,
      },
    });

    return NextResponse.json({
      success: true,
      period: actualPeriod,
      deleted: result.count,
    });
  } catch (error) {
    console.error('Error deleting period:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
