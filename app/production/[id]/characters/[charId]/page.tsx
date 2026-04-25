import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionMemberContext, getCharacterById, getProductionName } from "@/lib/db";
import { hasPermission } from "@/lib/roles";
import CharacterDetail from "@/components/CharacterDetail";

export default async function CharacterDetailPage({
  params,
}: {
  params: Promise<{ id: string; charId: string }>;
}) {
  const { id, charId } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { memberRoles, overrides } = await getProductionMemberContext(session.openId, session.isAdmin, id);
  if (!hasPermission("script:read", session.isAdmin, memberRoles, overrides)) redirect("/");

  const canEdit = hasPermission("script:metadata", session.isAdmin, memberRoles, overrides);

  const [name, character] = await Promise.all([
    getProductionName(id),
    getCharacterById(charId, id),
  ]);
  if (!name || !character) redirect(`/production/${id}/script`);

  return (
    <CharacterDetail
      productionId={id}
      productionName={name}
      character={character}
      canEdit={canEdit}
    />
  );
}
