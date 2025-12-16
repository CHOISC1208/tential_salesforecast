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
    const { newPeriod } = body;

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
          period: actualOldPeriod,
        },
      },
    });

    if (!oldPeriodBudget) {
      return NextResponse.json(
        { error: 'Period not found' },
        { status: 404 }
      );
    }

    // Check if new period name already exists
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

    // Use transaction to update both period budget and allocations
    const result = await prisma.$transaction(async (tx) => {
      // Delete old period budget (unique constraint)
      await tx.periodBudget.delete({
        where: {
          sessionId_period: {
            sessionId,
            period: actualOldPeriod,
          },
        },
      });

      // Create new period budget with same budget value
      await tx.periodBudget.create({
        data: {
          sessionId,
          period: newPeriod.trim(),
          budget: oldPeriodBudget.budget,
        },
      });

      // Update all allocations with the new period name
      const allocationsResult = await tx.allocation.updateMany({
        where: {
          sessionId,
          period: actualOldPeriod,
        },
        data: {
          period: newPeriod.trim(),
        },
      });

      return { updated: allocationsResult.count };
    });

    return NextResponse.json({
      success: true,
      oldPeriod: actualOldPeriod,
      newPeriod: newPeriod.trim(),
      updated: result.updated,
    });
  } catch (error) {
    console.error('Error renaming period:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
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

    // Prevent deletion of default period
    if (actualPeriod === null) {
      return NextResponse.json(
        { error: 'Cannot delete default period' },
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

    // Check if period budget exists
    const periodBudget = await prisma.periodBudget.findUnique({
      where: {
        sessionId_period: {
          sessionId,
          period: actualPeriod,
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
          period: actualPeriod,
        },
      },
    });

    // Also explicitly delete allocations to get count
    const result = await prisma.allocation.deleteMany({
      where: {
        sessionId,
        period: actualPeriod,
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
