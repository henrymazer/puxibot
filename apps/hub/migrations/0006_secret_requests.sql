-- Pedido de segredo: o agente pede, a pessoa digita numa caixa da interface e o valor vai direto para o
-- cofre ou para o conector. O valor nunca passa pela conversa nem volta para o agente.
-- approvals.kind ganha o valor 'secret'; secret_target guarda o destino (JSON, sem nenhum segredo).
ALTER TABLE approvals ADD COLUMN secret_target TEXT;
