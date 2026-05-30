import re

with open('/home/zyxolat/Desktop/QuestForge AI/backend/src/services/auth.ts', 'r') as f:
    content = f.read()

# Find the second DELETE followed by INSERT (not the first one which only cleans expired)
# Pattern: 
#   await prisma.$executeRaw`
#     DELETE FROM "AuthChallenge"
#     WHERE wallet = ${normalizedWallet}
#       AND "consumedAt" IS NULL
#   `;
#   [non-transactional code...]
#   const [challenge] = await prisma.$queryRaw<AuthChallengeRow[]>`
#     INSERT INTO "AuthChallenge" ...
#   `;

# Strategy: Find the second DELETE by looking for the second occurrence
idx1 = content.find('await prisma.$executeRaw`')
idx1 = content.find('await prisma.$executeRaw`', idx1 + 1)

# Find the start of this block (the delete statement)
delete_start = content.find('DELETE FROM "AuthChallenge"', idx1)
line_start = content.rfind('\n', 0, delete_start) + 1

# Find the INSERT that follows it
insert_idx = content.find('await prisma.$queryRaw<AuthChallengeRow[]>', idx1)
insert_line_start = content.rfind('\n', 0, insert_idx) + 1

# Find the end of the INSERT (the semicolon after the backtick)
insert_end = content.find('`;', insert_idx)
insert_end = content.find(';', insert_end) + 1

print(f'DELETE at position {line_start}')
print(f'INSERT at position {insert_line_start}')
print(f'INSERT ends at position {insert_end}')

extract = content[line_start:insert_end]
print('Extracted block:')
print(extract[:500])
