"""
Genererer en liten, fiktiv IFC4-modell av «Hovedbygg» i Sagbruket kontorpark (demodata).
Brukes av demodataene i Plank (public/samples/sagbruket-hovedbygg.ifc).

  pip install ifcopenshell
  python3 scripts/make-sample-ifc.py
"""
import os

import numpy as np
import ifcopenshell
import ifcopenshell.api
from ifcopenshell.util.shape_builder import ShapeBuilder

run = ifcopenshell.api.run
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "samples", "sagbruket-hovedbygg.ifc")

model = ifcopenshell.file(schema="IFC4")
project = run("root.create_entity", model, ifc_class="IfcProject", name="Sagbruket kontorpark")
run("unit.assign_unit", model, length={"is_metric": True, "raw": "METERS"}, area={"is_metric": True, "raw": "SQUARE_METERS"}, volume={"is_metric": True, "raw": "CUBIC_METERS"})
ctx = run("context.add_context", model, context_type="Model")
body = run("context.add_context", model, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=ctx)
builder = ShapeBuilder(model)

site = run("root.create_entity", model, ifc_class="IfcSite", name="Sagbruksveien 4")
building = run("root.create_entity", model, ifc_class="IfcBuilding", name="Hovedbygg")
run("aggregate.assign_object", model, relating_object=project, products=[site])
run("aggregate.assign_object", model, relating_object=site, products=[building])

W, D = 30.0, 16.0  # bygningens fotavtrykk (m)
STOREYS = [
    ("Kjeller (U1)", -3.2, 3.2),
    ("1. etasje", 0.0, 3.6),
    ("2. etasje", 3.6, 3.6),
    ("3. etasje", 7.2, 3.6),
]

# Rom per etasje: (nummer, navn, x, y, bredde, dybde)
ROOMS = {
    "Kjeller (U1)": [("U-010", "Teknisk rom ventilasjon", 0, 0, 8, 8), ("U-012", "Hovedtavlerom", 8, 0, 4, 4.5), ("U-020", "Sykkelparkering", 12, 0, 18, 8)],
    "1. etasje": [("1-001", "Resepsjon", 0, 0, 10, 8.5), ("1-005", "Heissjakt", 10, 0, 2, 3), ("1-010", "Kantine", 12, 0, 18, 12)],
    "2. etasje": [("2-001", "Kontorlandskap nord", 0, 0, 22, 16), ("2-014", "Pantry", 22, 0, 4, 5.5), ("2-020", "Møterom Furu", 26, 0, 4, 7)],
    "3. etasje": [("3-001", "Kontorlandskap sør", 0, 0, 24, 16), ("3-012", "Møterom Gran", 24, 0, 6, 5.3)],
}


def place(product, x=0.0, y=0.0, z=0.0, rot=0.0):
    m = np.eye(4)
    c, s = np.cos(rot), np.sin(rot)
    m[0][0], m[0][1], m[1][0], m[1][1] = c, -s, s, c
    m[0][3], m[1][3], m[2][3] = x, y, z
    run("geometry.edit_object_placement", model, product=product, matrix=m, is_si=True)


def box(product, w, d, h):
    profile = builder.rectangle(size=np.array([w, d]))
    solid = builder.extrude(profile, magnitude=h)
    rep = builder.get_representation(body, [solid])
    run("geometry.assign_representation", model, product=product, representation=rep)


def color(rep_product, rgb, transparency=0.0):
    style = run("style.add_style", model)
    run("style.add_surface_style", model, style=style, ifc_class="IfcSurfaceStyleShading",
        attributes={"SurfaceColour": {"Name": None, "Red": rgb[0], "Green": rgb[1], "Blue": rgb[2]}, "Transparency": transparency})
    for rep in rep_product.Representation.Representations:
        run("style.assign_representation_styles", model, shape_representation=rep, styles=[style])


for name, elevation, height in STOREYS:
    storey = run("root.create_entity", model, ifc_class="IfcBuildingStorey", name=name)
    storey.Elevation = elevation
    run("aggregate.assign_object", model, relating_object=building, products=[storey])
    place(storey, z=elevation)
    contained = []

    slab = run("root.create_entity", model, ifc_class="IfcSlab", name=f"Dekke {name}", predefined_type="FLOOR")
    place(slab, z=elevation - 0.25)
    box(slab, W, D, 0.25)
    color(slab, (0.72, 0.70, 0.66))
    contained.append(slab)

    # Yttervegger
    t = 0.3
    for i, (x, y, w, d) in enumerate([(0, 0, W, t), (0, D - t, W, t), (0, 0, t, D), (W - t, 0, t, D)]):
        wall = run("root.create_entity", model, ifc_class="IfcWall", name=f"Yttervegg {i + 1}", predefined_type="STANDARD")
        place(wall, x=x, y=y, z=elevation)
        box(wall, w, d, height - 0.25)
        color(wall, (0.86, 0.83, 0.78))
        contained.append(wall)

    # Vinduer i langveggene (ikke kjeller)
    if elevation >= 0:
        for k in range(6):
            for y in (-0.05, D - t - 0.05):
                win = run("root.create_entity", model, ifc_class="IfcWindow", name=f"Vindu {k + 1}", predefined_type="WINDOW")
                place(win, x=2 + k * 4.6, y=y, z=elevation + 0.9)
                box(win, 2.2, t + 0.1, 1.6)
                color(win, (0.55, 0.72, 0.85), 0.55)
                contained.append(win)

    # Rom
    for number, room_name, x, y, w, d in ROOMS[name]:
        space = run("root.create_entity", model, ifc_class="IfcSpace", name=number, predefined_type="INTERNAL")
        space.LongName = room_name
        run("aggregate.assign_object", model, relating_object=storey, products=[space])
        place(space, x=x + 0.15, y=y + 0.15, z=elevation)
        box(space, w - 0.3, d - 0.3, height - 0.4)
        qto = run("pset.add_qto", model, product=space, name="Qto_SpaceBaseQuantities")
        run("pset.edit_qto", model, qto=qto, properties={"NetFloorArea": round((w - 0.3) * (d - 0.3), 1)})
        door = run("root.create_entity", model, ifc_class="IfcDoor", name=f"Dør {number}", predefined_type="DOOR")
        place(door, x=x + w / 2, y=y + d - 0.1, z=elevation)
        box(door, 0.9, 0.12, 2.1)
        color(door, (0.62, 0.45, 0.30))
        contained.append(door)

    # Tilluftsventiler
    if elevation >= 0:
        for k in range(4):
            term = run("root.create_entity", model, ifc_class="IfcAirTerminal", name=f"Tilluftsventil {name} #{k + 1}", predefined_type="DIFFUSER")
            place(term, x=4 + k * 7, y=D / 2, z=elevation + height - 0.6)
            box(term, 0.6, 0.6, 0.15)
            color(term, (0.9, 0.9, 0.92))
            pset = run("pset.add_pset", model, product=term, name="Pset_ManufacturerTypeInformation")
            run("pset.edit_pset", model, pset=pset, properties={"Manufacturer": "Nordluft", "ModelLabel": "NL-D600"})
            contained.append(term)

    if name == "Kjeller (U1)":
        aggregat = run("root.create_entity", model, ifc_class="IfcUnitaryEquipment", name="Ventilasjonsaggregat VA01", predefined_type="AIRHANDLER")
        aggregat.Tag = "=360.001"
        place(aggregat, x=1.5, y=1.5, z=elevation)
        box(aggregat, 4.5, 1.6, 2.0)
        color(aggregat, (0.70, 0.74, 0.78))
        pset = run("pset.add_pset", model, product=aggregat, name="Pset_ManufacturerTypeInformation")
        run("pset.edit_pset", model, pset=pset, properties={"Manufacturer": "Nordluft", "ModelLabel": "NL-4000 Roterende", "ProductionYear": "2019"})
        contained.append(aggregat)
        pump = run("root.create_entity", model, ifc_class="IfcUnitaryEquipment", name="Væske-vann varmepumpe VP01")
        pump.Tag = "=320.001"
        place(pump, x=1.5, y=5.0, z=elevation)
        box(pump, 1.2, 0.9, 1.8)
        color(pump, (0.80, 0.80, 0.82))
        contained.append(pump)

    run("spatial.assign_container", model, relating_structure=storey, products=contained)

# Heis gjennom alle etasjer
lift = run("root.create_entity", model, ifc_class="IfcTransportElement", name="Personheis H1", predefined_type="ELEVATOR")
lift.Tag = "=621.001"
place(lift, x=10.2, y=0.2, z=-3.2)
box(lift, 1.6, 2.6, 14.0)
color(lift, (0.65, 0.60, 0.55))
first_storey = [s for s in model.by_type("IfcBuildingStorey") if s.Name == "1. etasje"][0]
run("spatial.assign_container", model, relating_structure=first_storey, products=[lift])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
model.write(OUT)
print("Skrev", os.path.relpath(OUT), os.path.getsize(OUT), "bytes")
