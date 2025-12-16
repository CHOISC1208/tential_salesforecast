import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { z } from 'zod';

const periodSchema = z.object({
  period: z.string().min(1).max(100),
  budget: z.number().int().positive(),
  copyFrom: z.string().optional()
});

/**
 * GET /api/sessions/[id]/periods
 * Get list of all periods with budgets for a session
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params;

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

    // Get period budgets from period_budgets table
    const periodBudgets = await prisma.periodBudget.findMany({
      where: { sessionId },
      orderBy: { period: 'asc' }
    });

    // Sort: null (default) comes first, then alphabetically
    const sorted = periodBudgets.sort((a, b) => {
      if (a.period === null) return -1;
      if (b.period === null) return 1;
      return a.period.localeCompare(b.period);
    });

    return NextResponse.json({
      periods: sorted.map(pb => pb.period)
    });
  } catch (error) {
    console.error('Error fetching periods:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/sessions/[id]/periods
 * Add a new period with budget (with option to copy existing allocations)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: sessionId } = await params;
    const body = await request.json();
    const { period, budget, copyFrom } = periodSchema.parse(body);

    const periodName = period.trim();

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

    // Check if period already exists in period_budgets
    const existingPeriodBudget = await prisma.periodBudget.findUnique({
      where: {
        sessionId_period: {
          sessionId,
          period: periodName,
        },
      },
    });

    if (existingPeriodBudget) {
      return NextResponse.json(
        { error: 'Period already exists' },
        { status: 409 }
      );
    }

    // Create period budget
    await prisma.periodBudget.create({
      data: {
        sessionId,
        period: periodName,
        budget: BigInt(budget)
      }
    });

    // Handle allocation copying if copyFrom is provided
    if (copyFrom !== undefined && copyFrom !== '') {
      // Copy allocations from another period
      const sourceAllocations = await prisma.allocation.findMany({
        where: {
          sessionId,
          period: copyFrom,
        },
      });

      // If source has allocations, copy them
      if (sourceAllocations.length > 0) {
        await prisma.allocation.createMany({
          data: sourceAllocations.map(allocation => ({
            sessionId: allocation.sessionId,
            hierarchyPath: allocation.hierarchyPath,
            level: allocation.level,
            percentage: allocation.percentage,
            amount: allocation.amount,
            quantity: allocation.quantity,
            period: periodName,
          })),
        });

        return NextResponse.json({
          success: true,
          period: periodName,
          budget: budget.toString(),
          copied: sourceAllocations.length,
        });
      }
    }

    // If no source to copy from, or source is empty, create placeholder allocations
    // Get session's hierarchy structure from SKU data
    const skuData = await prisma.skuData.findMany({
      where: { sessionId },
    });

    const hierarchyDefinitions = await prisma.hierarchyDefinition.findMany({
      where: { sessionId },
      orderBy: { level: 'asc' },
    });

    if (skuData.length > 0 && hierarchyDefinitions.length > 0) {
      // Build hierarchy paths from SKU data
      const hierarchyPaths = new Set<string>();

      for (const sku of skuData) {
        const hierarchyValues = sku.hierarchyValues as Record<string, string>;

        for (let level = 1; level <= hierarchyDefinitions.length; level++) {
          const pathParts: string[] = [];

          for (let i = 0; i < level; i++) {
            const def = hierarchyDefinitions[i];
            const value = hierarchyValues[def.columnName];
            if (value) {
              pathParts.push(value);
            }
          }

          if (pathParts.length === level) {
            hierarchyPaths.add(pathParts.join('/'));
          }
        }
      }

      // Count children for each parent path to determine which nodes should be 100%
      const childrenCount = new Map<string, Set<string>>();

      for (const path of hierarchyPaths) {
        const parts = path.split('/');
        if (parts.length > 1) {
          const parentPath = parts.slice(0, -1).join('/');
          if (!childrenCount.has(parentPath)) {
            childrenCount.set(parentPath, new Set());
          }
          childrenCount.get(parentPath)!.add(path);
        }
      }

      // Create allocations with automatic 100% for single children
      const allocations = Array.from(hierarchyPaths).map(path => {
        const parts = path.split('/');
        let percentage = 0;

        // If this node is the only child of its parent, set to 100%
        if (parts.length > 1) {
          const parentPath = parts.slice(0, -1).join('/');
          const siblings = childrenCount.get(parentPath);
          if (siblings && siblings.size === 1) {
            percentage = 100;
          }
        } else {
          // Top level - check if there's only one top-level item
          const topLevelPaths = Array.from(hierarchyPaths).filter(p => p.split('/').length === 1);
          if (topLevelPaths.length === 1) {
            percentage = 100;
          }
        }

        return {
          sessionId,
          hierarchyPath: path,
          level: parts.length,
          percentage,
          amount: BigInt(0),
          quantity: 0,
          period: periodName,
        };
      });

      if (allocations.length > 0) {
        await prisma.allocation.createMany({
          data: allocations,
        });
      }
    }

    return NextResponse.json({
      success: true,
      period: periodName,
      budget: budget.toString(),
      copied: 0,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input', details: error.errors },
        { status: 400 }
      );
    }

    console.error('Error adding period:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
