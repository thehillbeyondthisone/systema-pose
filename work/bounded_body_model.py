"""Evaluate body meshes in batches without changing the fitted parameters."""
from dataclasses import fields


def bound_body_model(model, batch_size=64):
    if getattr(model, '_systema_bounded_forward', False):return model
    original = model.forward

    def forward(*args, **kwargs):
        import torch
        tensors = [value for value in (*args, *kwargs.values()) if torch.is_tensor(value) and value.ndim >= 2]
        count = max((value.shape[0] for value in tensors), default=1)
        if count <= batch_size:return original(*args, **kwargs)
        def sliced(value, start, end):
            return value[start:end] if torch.is_tensor(value) and value.ndim and value.shape[0] == count else value
        outputs, lengths = [], []
        for start in range(0, count, batch_size):
            end = min(count, start + batch_size)
            lengths.append(end - start)
            outputs.append(original(*(sliced(value, start, end) for value in args),
                                    **{key: sliced(value, start, end) for key, value in kwargs.items()}))
        values = {}
        for field in fields(outputs[0]):
            parts = [getattr(output, field.name) for output in outputs]
            batched = torch.is_tensor(parts[0]) and all(part.ndim and part.shape[0] == length for part, length in zip(parts, lengths))
            values[field.name] = torch.cat(parts, dim=0) if batched else parts[0]
        return type(outputs[0])(**values)

    model.forward = forward
    model._systema_bounded_forward = True
    return model
